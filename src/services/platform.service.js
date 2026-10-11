const mongoose = require("mongoose");
const Organisation = require("../models/Organisation");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const SeatCounter = require("../models/SeatCounter");
const ApiError = require("../utils/ApiError");
const tenant = require("../utils/tenantContext");
const modules = require("../config/modules");
const { ROLES } = require("../config/roles");
const { recordAuditLog } = require("./audit.service");
const { invalidate, computeEntitlements } = require("./organisation.service");

/**
 * The product owner's console (module-access-plan.md, Phase 2).
 *
 * The product owner sees organisations, their modules, seats and usage COUNTS only
 * (M3): no names, emails, chats, leads or payments of anyone inside them. Counts
 * are read in system context with grouped aggregates (one query for every row),
 * never by loading the documents.
 */

const oid = (v) => new mongoose.Types.ObjectId(String(v));

// ── Read ──────────────────────────────────────────────────────────────────────

/** The module catalog as the console shows it. */
const listModules = () =>
  modules.MODULES.map((m) => ({
    key: m.key,
    label: m.label,
    description: m.description,
    core: Boolean(m.core),
    defaultOn: Boolean(m.defaultOn),
    orgWide: Boolean(m.orgWide),
    staffOnly: m.audience === "staff",
    requires: m.requires || [],
    // Everything this pulls in, and everything that would stop working without it
    requiresAll: modules.fromMask(modules.REQUIRES_MASK[m.key]),
    neededBy: modules.fromMask(modules.DEPENDENTS_MASK[m.key])
  }));

/** People per organisation: one grouped query → Map<orgId, counts>. */
const usageByOrg = async (orgIds) => {
  if (!orgIds.length) return new Map();
  const rows = await tenant.runAsSystem(() =>
    User.aggregate([
      { $match: { orgId: { $in: orgIds.map(oid) }, deletedAt: null } },
      {
        $group: {
          _id: "$orgId",
          staff: { $sum: { $cond: [{ $ne: ["$role", ROLES.CUSTOMER] }, 1, 0] } },
          customers: { $sum: { $cond: [{ $eq: ["$role", ROLES.CUSTOMER] }, 1, 0] } },
          active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
          activeLast30Days: {
            $sum: { $cond: [{ $gte: ["$lastLogin", new Date(Date.now() - 30 * 24 * 3600 * 1000)] }, 1, 0] }
          }
        }
      }
    ])
  );
  return new Map(rows.map((r) => [String(r._id), { staff: r.staff, customers: r.customers, active: r.active, activeLast30Days: r.activeLast30Days }]));
};

const EMPTY_USAGE = Object.freeze({ staff: 0, customers: 0, active: 0, activeLast30Days: 0 });

/** Seats in use per organisation and module (counts only): Map<orgId, Map<key, used>>. */
const seatsByOrg = async (orgIds) => {
  if (!orgIds.length) return new Map();
  const rows = await tenant.runAsSystem(() => SeatCounter.find({ orgId: { $in: orgIds.map(oid) } }).select("orgId module used").lean());
  const out = new Map();
  for (const r of rows) {
    if (!out.has(String(r.orgId))) out.set(String(r.orgId), new Map());
    out.get(String(r.orgId)).set(r.module, r.used);
  }
  return out;
};

/** Every module of an organisation, with what was set and whether it is in effect now. */
const describeModules = (org, seats = new Map()) => {
  const { mask } = computeEntitlements(org);
  const set = new Map((org.modules || []).map((m) => [m.key, m]));
  return modules.MODULES.map((m) => {
    const grant = set.get(m.key);
    return {
      key: m.key,
      core: Boolean(m.core),
      // On-by-default modules count as on until switched off explicitly
      enabled: m.core ? true : grant ? Boolean(grant.enabled) : Boolean(m.defaultOn),
      defaultOn: Boolean(m.defaultOn),
      orgWide: Boolean(m.orgWide),
      expiresAt: grant?.expiresAt || null,
      seatLimit: grant?.seatLimit ?? null,
      seatsUsed: m.core || m.orgWide ? null : seats.get(m.key) || 0,
      // Switched on but not usable: expired, or something it needs is off
      effective: (mask & modules.BIT[m.key]) !== 0
    };
  });
};

const publicOrg = (org, usage, seats) => ({
  _id: org._id,
  name: org.name,
  slug: org.slug,
  displayName: org.displayName || null,
  status: org.status,
  createdAt: org.createdAt,
  entitlementVersion: org.entitlementVersion,
  modules: describeModules(org, seats),
  usage: usage || EMPTY_USAGE
});

const listOrganisations = async ({ search, status } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { slug: rx }];
  }
  const orgs = await Organisation.find(filter).sort({ name: 1 }).limit(500).lean();
  const ids = orgs.map((o) => o._id);
  const [usage, seats] = await Promise.all([usageByOrg(ids), seatsByOrg(ids)]);
  return orgs.map((o) => publicOrg(o, usage.get(String(o._id)), seats.get(String(o._id))));
};

const getOrganisation = async (id) => {
  const org = await Organisation.findById(id).lean();
  if (!org) throw new ApiError(404, "Organisation not found");
  const [usage, seats] = await Promise.all([usageByOrg([org._id]), seatsByOrg([org._id])]);
  return publicOrg(org, usage.get(String(org._id)), seats.get(String(org._id)));
};

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Adds the modules to a module list, plus everything they require (closure mask:
 * one lookup per module). Returns the new list and the keys that were pulled in.
 */
const withModulesOn = (list, keys, actorId) => {
  const byKey = new Map(list.map((m) => [m.key, { ...m }]));
  const wanted = keys.reduce((mask, k) => mask | modules.BIT[k] | modules.REQUIRES_MASK[k], 0);
  const pulledIn = [];
  for (const key of modules.fromMask(wanted)) {
    if (modules.isCore(key)) continue;
    const cur = byKey.get(key);
    if (cur?.enabled) continue;
    if (!keys.includes(key)) pulledIn.push(key);
    byKey.set(key, { key, enabled: true, expiresAt: cur?.expiresAt ?? null, seatLimit: cur?.seatLimit ?? null, updatedAt: new Date(), updatedBy: actorId });
  }
  return { list: [...byKey.values()], pulledIn };
};

/**
 * Creates an organisation with its first superadmin. That person must change the
 * initial password at first sign-in (so the product owner never knows it for long).
 */
const createOrganisation = async ({ name, slug, modules: moduleKeys = [], superadmin }, req) => {
  if (await Organisation.exists({ slug })) throw new ApiError(409, "That organisation code is already taken", [{ code: "SLUG_TAKEN" }]);

  const { list } = withModulesOn([], moduleKeys, req.user._id);
  let org;
  try {
    org = await Organisation.create({ name, slug, modules: list, createdBy: req.user._id });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, "That organisation code is already taken", [{ code: "SLUG_TAKEN" }]);
    throw err;
  }

  try {
    await tenant.runInOrg(org._id, async () => {
      const user = new User({
        name: superadmin.name,
        email: superadmin.email,
        role: ROLES.SUPERADMIN,
        createdBy: null,
        mustChangePassword: true
      });
      user.setDerivedCredential(superadmin.authKey, superadmin.kdfSalt);
      // The superadmin holds every module, so takes a seat in each
      await require("./moduleAccess.service").transition(null, user, () => user.save());
    });
  } catch (err) {
    // No half-created organisations: remove it again (no multi-document transactions needed)
    await Organisation.deleteOne({ _id: org._id });
    await tenant.runAsSystem(() => SeatCounter.deleteMany({ orgId: org._id }));
    throw err;
  }

  await recordAuditLog({
    req,
    action: "platform_org_created",
    targetType: "Organisation",
    targetId: org._id,
    metadata: { name, slug, modules: modules.fromMask(modules.toMask(list.map((m) => m.key))) }
  });
  return getOrganisation(org._id);
};

const updateOrganisation = async (id, patch, req) => {
  const before = await Organisation.findById(id).select("name status displayName").lean();
  if (!before) throw new ApiError(404, "Organisation not found");
  await Organisation.updateOne({ _id: id }, { $set: patch, $inc: { entitlementVersion: patch.status ? 1 : 0 } });
  invalidate(id);

  // Suspending signs everyone out of live connections at once; REST calls are
  // refused by the auth gate from the next request
  if (patch.status === "suspended" && before.status !== "suspended") {
    const { getIO } = require("../sockets");
    const io = getIO();
    if (io) {
      const ids = await tenant.runAsSystem(() => User.find({ orgId: id }).select("_id").lean());
      for (const u of ids) io.in(`user:${u._id}`).disconnectSockets(true);
    }
  }

  await recordAuditLog({
    req,
    action: patch.status && patch.status !== before.status ? `platform_org_${patch.status}` : "platform_org_updated",
    targetType: "Organisation",
    targetId: id,
    metadata: { before, after: patch }
  });
  return getOrganisation(id);
};

/**
 * Switches one module on or off for an organisation, or changes its end date / seats.
 *
 * - Switching on also switches on everything it requires (REQUIRES_MASK).
 * - Switching off is refused while another switched-on module needs it
 *   (DEPENDENTS_MASK), and the response names those modules.
 * - Optimistic concurrency on entitlementVersion: two product owners editing at
 *   once can't overwrite each other silently.
 * - People keep their own grants when a module goes off (Phase 4 lazy cascade):
 *   the organisation mask hides them, so switching back on restores everyone.
 */
const setModule = async (id, key, { enabled, expiresAt, seatLimit }, req) => {
  if (!modules.isModule(key)) throw new ApiError(404, "Unknown module");
  if (modules.isCore(key)) throw new ApiError(400, "Core modules are always on");
  if ((modules.isDefaultOn(key) || modules.isOrgWide(key)) && seatLimit != null) throw new ApiError(400, "This module is on for everyone, so it has no seats");

  const org = await Organisation.findById(id).select("modules entitlementVersion").lean();
  if (!org) throw new ApiError(404, "Organisation not found");

  const current = new Map((org.modules || []).map((m) => [m.key, m]));
  const before = current.get(key) || null;
  let list = org.modules || [];
  let pulledIn = [];

  if (enabled === false) {
    const onMask = modules.toMask(list.filter((m) => m.enabled).map((m) => m.key));
    const blockers = modules.fromMask(modules.DEPENDENTS_MASK[key] & onMask);
    if (blockers.length) {
      throw new ApiError(409, `Switch off ${blockers.map((k) => modules.getModule(k).label).join(", ")} first: ${blockers.length > 1 ? "they need" : "it needs"} this module.`, [
        { code: "MODULE_NEEDED", modules: blockers }
      ]);
    }
  } else if (enabled === true) {
    ({ list, pulledIn } = withModulesOn(list, [key], req.user._id));
  }

  const next = new Map(list.map((m) => [m.key, { ...m }]));
  const row = next.get(key) || { key, enabled: false, expiresAt: null, seatLimit: null };
  if (enabled !== undefined) row.enabled = enabled;
  if (expiresAt !== undefined) row.expiresAt = expiresAt;
  if (seatLimit !== undefined) row.seatLimit = seatLimit;
  row.updatedAt = new Date();
  row.updatedBy = req.user._id;
  next.set(key, row);

  const res = await Organisation.updateOne(
    { _id: id, entitlementVersion: org.entitlementVersion },
    { $set: { modules: [...next.values()] }, $inc: { entitlementVersion: 1 } },
    { runValidators: true }
  );
  if (res.matchedCount === 0) {
    throw new ApiError(409, "Someone else just changed this organisation's modules. Reload and try again.", [{ code: "STALE_VERSION" }]);
  }
  invalidate(id);

  await recordAuditLog({
    req,
    action: "platform_module_changed",
    targetType: "Organisation",
    targetId: id,
    metadata: {
      module: key,
      before: before && { enabled: before.enabled, expiresAt: before.expiresAt, seatLimit: before.seatLimit },
      after: { enabled: row.enabled, expiresAt: row.expiresAt, seatLimit: row.seatLimit },
      pulledIn
    }
  });
  return { organisation: await getOrganisation(id), pulledIn };
};

/** The product owner's own audit trail (platform-level entries only, orgId null). */
const listPlatformAudit = async ({ limit = 100 } = {}) =>
  AuditLog.find({ targetType: { $in: ["Organisation", "OrgTemplate"] } }).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).populate("actor", "name").lean();

module.exports = {
  listModules,
  listOrganisations,
  getOrganisation,
  createOrganisation,
  updateOrganisation,
  setModule,
  listPlatformAudit,
  withModulesOn
};
