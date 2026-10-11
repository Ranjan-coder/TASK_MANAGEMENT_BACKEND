const SeatCounter = require("../models/SeatCounter");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const modules = require("../config/modules");
const { ROLES, PLATFORM_OWNER } = require("../config/roles");
const { requireOrgId } = require("../utils/tenantContext");

/**
 * Who in an organisation may use which module (module-access-plan.md, Phase 4).
 *
 *   person can use module  ⇔  bit set in effectiveMask(orgMask & userMask)
 *
 * - userMask comes from user.moduleAccess. A superadmin always holds everything;
 *   an admin holds everything unless a superadmin narrows it (`all: false`, M4);
 *   other staff hold only what they were given; customers follow the organisation.
 * - When the product owner switches a module off, people keep their own grants:
 *   the organisation mask simply hides them (lazy cascade, no write per person),
 *   and switching it back on restores everyone at once.
 *
 * Seats: a person "holds a seat" in every switchable module of their userMask while
 * they are active staff. Counters change only through transition()/bulk grants:
 * gained seats are claimed BEFORE the person is saved (refused if full), lost
 * seats are released after; a failed save gives the claimed seats back.
 */
const TOGGLEABLE_MASK = modules.ALL_MASK & ~modules.CORE_MASK;
// Modules people hold one by one (and take seats in): not core, not on-by-default,
// not organisation-wide settings (e.g. branding)
const GRANTABLE_MASK = TOGGLEABLE_MASK & ~modules.DEFAULT_ON_MASK & ~modules.ORG_WIDE_MASK;
// Everything a customer may use, before the organisation's opt-ins
const CUSTOMER_BASE_MASK = modules.ALL_MASK & ~modules.STAFF_ONLY_MASK;

/** Does this person hold every module by default? */
const holdsAll = (user) =>
  user.role === ROLES.SUPERADMIN || user.moduleAccess?.all === true || (user.moduleAccess?.all == null && user.role === ROLES.ADMIN);

/**
 * Modules this person holds, before the organisation's own modules are applied.
 * customerMask: staff-only modules the organisation opened to its customers.
 */
const userModuleMask = (user, customerMask = 0) => {
  if (!user || user.role === PLATFORM_OWNER) return 0;
  if (user.role === ROLES.CUSTOMER) return CUSTOMER_BASE_MASK | (modules.STAFF_ONLY_MASK & customerMask);
  if (holdsAll(user)) return modules.ALL_MASK;
  // Staff: core, everything on by default (e.g. Planner), organisation-wide settings
  // (e.g. branding), and what they were given
  return modules.CORE_MASK | modules.DEFAULT_ON_MASK | modules.ORG_WIDE_MASK | modules.toMask(user.moduleAccess?.keys || []);
};

/** What this person can actually use: both masks, then the dependency rule. */
const effectiveUserMask = (user, orgMask, customerMask = 0) => modules.effectiveMask(orgMask & userModuleMask(user, customerMask));

/** Seats this person takes: switchable modules, active staff only. */
const seatMask = (user) => {
  if (!user || user.role === ROLES.CUSTOMER || user.role === PLATFORM_OWNER) return 0;
  if (user.status !== "active" || user.deletedAt) return 0;
  return userModuleMask(user) & GRANTABLE_MASK; // on-by-default modules never take seats
};

/** Module keys this person can use right now (what the app shows them). */
const modulesFor = async (user) => {
  if (!user?.orgId) return [];
  const { getEntitlements } = require("./organisation.service");
  const { mask, customerMask } = await getEntitlements(user.orgId);
  return modules.fromMask(effectiveUserMask(user, mask, customerMask));
};

// ── Seat counters ─────────────────────────────────────────────────────────────

/** Map<moduleKey, seatLimit|null> for the current organisation (cached entitlements). */
const seatLimits = async () => {
  const { getSeatLimits } = require("./organisation.service");
  return getSeatLimits(requireOrgId());
};

/** Claims n seats of one module, atomically. False if that would pass the limit. */
const claim = async (key, n, limit) => {
  if (n <= 0) return true;
  if (limit == null) {
    await SeatCounter.updateOne({ module: key }, { $inc: { used: n } }, { upsert: true });
    return true;
  }
  if (n > limit) return false;
  try {
    // Matches only while there is room; a full counter makes the upsert try to
    // insert a duplicate, which the unique index refuses: either way, no seat.
    const doc = await SeatCounter.findOneAndUpdate({ module: key, used: { $lte: limit - n } }, { $inc: { used: n } }, { upsert: true, new: true });
    return Boolean(doc);
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
};

/** Gives n seats back (never below zero). */
const release = (key, n) =>
  n > 0 ? SeatCounter.updateOne({ module: key }, [{ $set: { used: { $max: [0, { $subtract: [{ $ifNull: ["$used", 0] }, n] }] } } }]) : null;

/** Claims every module in `counts` (Map key → n) or none of them. */
const claimAll = async (counts) => {
  const limits = await seatLimits();
  const taken = [];
  for (const [key, n] of counts) {
    if (await claim(key, n, limits.get(key) ?? null)) {
      taken.push([key, n]);
      continue;
    }
    await Promise.all(taken.map(([k, m]) => release(k, m))); // all or nothing
    const label = modules.getModule(key).label;
    throw new ApiError(409, `No ${label} seats left. Ask the product owner for more seats, or free one first.`, [{ code: "SEATS_FULL", module: key }]);
  }
};

const releaseAll = (counts) => Promise.all([...counts].map(([key, n]) => release(key, n)));

const countsOf = (mask, n = 1) => new Map(modules.fromMask(mask).map((k) => [k, n]));

/**
 * Runs `write` (which saves the person) with seats kept in step:
 * claim what they gain → write → release what they lose. If the write throws,
 * the claimed seats are given back and the error goes on.
 */
const transition = async (before, after, write) => {
  const was = seatMask(before);
  const now = seatMask(after);
  const gained = countsOf(now & ~was);
  const lost = countsOf(was & ~now);
  await claimAll(gained);
  let result;
  try {
    result = await write();
  } catch (err) {
    await releaseAll(gained);
    throw err;
  }
  await releaseAll(lost);
  return result;
};

/** Seats in use per module: Map key → used. */
const seatUsage = async () => {
  const rows = await SeatCounter.find().select("module used").lean();
  return new Map(rows.map((r) => [r.module, r.used]));
};

/**
 * Rebuilds the counters from the people themselves (one query, O(people × modules)
 * in memory). Run by the migration and hourly by the monitor, so any drift heals.
 */
const QUIET_MS = 60 * 1000;

/**
 * Compare-and-set, so a recount never undoes a change in progress: a counter is
 * only corrected if it still holds the value read before counting AND nobody has
 * touched it for a minute (a claim made just before the count, whose person isn't
 * saved yet, would otherwise be wiped). Skipped counters are fixed next hour.
 */
const recountSeats = async () => {
  const before = new Map((await SeatCounter.find().select("module used updatedAt").lean()).map((c) => [c.module, c]));
  const people = await User.find({ role: { $nin: [ROLES.CUSTOMER] }, status: "active", deletedAt: null })
    .select("role status deletedAt moduleAccess")
    .lean();
  const counts = new Map(modules.fromMask(GRANTABLE_MASK).map((k) => [k, 0]));
  for (const p of people) for (const k of modules.fromMask(seatMask(p))) counts.set(k, counts.get(k) + 1);

  const quietBefore = new Date(Date.now() - QUIET_MS);
  const ops = [];
  for (const [module, used] of counts) {
    const cur = before.get(module);
    if (!cur) ops.push({ updateOne: { filter: { module }, update: { $setOnInsert: { used } }, upsert: true } });
    else if (cur.used !== used && (!cur.updatedAt || cur.updatedAt < quietBefore)) {
      ops.push({ updateOne: { filter: { module, used: cur.used, updatedAt: cur.updatedAt ?? null }, update: { $set: { used } } } });
    }
  }
  if (ops.length) await SeatCounter.bulkWrite(ops, { ordered: false });
  return counts;
};

// ── Choosing modules ──────────────────────────────────────────────────────────

/**
 * Normalises a requested set of modules for a person: only switchable modules the
 * organisation has, plus everything they require (closure mask). Returns keys.
 */
const resolveKeys = (keys, orgMask) => {
  const unknown = keys.filter((k) => !modules.isModule(k) || modules.isCore(k));
  if (unknown.length) throw new ApiError(400, `Unknown module: ${unknown.join(", ")}`);
  // On-by-default and organisation-wide modules are held by everyone already, so they are never stored per person
  const wanted = keys.reduce((mask, k) => mask | modules.BIT[k] | modules.REQUIRES_MASK[k], 0) & GRANTABLE_MASK;
  const missing = modules.fromMask(wanted & ~orgMask);
  if (missing.length) {
    throw new ApiError(400, `Your organisation doesn't have ${missing.map((k) => modules.getModule(k).label).join(", ")}`, [{ code: "MODULE_NOT_IN_ORG", modules: missing }]);
  }
  return modules.fromMask(wanted);
};

// ── Bulk ──────────────────────────────────────────────────────────────────────

const MAX_BULK = 200;

/**
 * Gives one module to many people, or takes it away, in one go:
 * one read, one seat claim per module for the whole batch (all or nothing),
 * one bulkWrite, one re-read to settle seats for anyone changed concurrently.
 *
 * Taking a module away also takes what needs it (DEPENDENTS_MASK). Taking it from
 * someone who holds everything (an admin by default) turns them into "custom":
 * every module the organisation has, minus this one and what needs it.
 */
const bulkSetModule = async (key, { add = [], remove = [] }, orgMask) => {
  if (!modules.isModule(key) || modules.isCore(key)) throw new ApiError(400, "Unknown module");
  if (modules.isDefaultOn(key) || modules.isOrgWide(key)) throw new ApiError(400, "Everyone has this module already", [{ code: "MODULE_DEFAULT_ON" }]);
  if (!(orgMask & modules.BIT[key])) throw new ApiError(400, "Your organisation doesn't have this module", [{ code: "MODULE_NOT_IN_ORG", modules: [key] }]);
  const ids = [...new Set([...add, ...remove].map(String))];
  if (ids.length > MAX_BULK) throw new ApiError(400, `At most ${MAX_BULK} people at a time`);
  const removing = new Set(remove.map(String));

  const people = await User.find({ _id: { $in: ids } }).select("role status deletedAt moduleAccess");
  const plans = [];
  const gained = new Map();
  const bump = (map, mask) => modules.fromMask(mask).forEach((k) => map.set(k, (map.get(k) || 0) + 1));

  for (const p of people) {
    if (p.role === ROLES.CUSTOMER || p.role === ROLES.SUPERADMIN) continue;
    const curMask = userModuleMask(p) & GRANTABLE_MASK;
    let nextAccess;
    if (removing.has(String(p._id))) {
      const drop = modules.BIT[key] | modules.DEPENDENTS_MASK[key];
      if (!(curMask & modules.BIT[key])) continue;
      const base = holdsAll(p) ? orgMask & GRANTABLE_MASK : curMask;
      nextAccess = { all: false, keys: modules.fromMask(base & ~drop) };
    } else {
      if (holdsAll(p) || curMask & modules.BIT[key]) continue;
      nextAccess = { all: p.moduleAccess?.all ?? null, keys: resolveKeys([...(p.moduleAccess?.keys || []), key], orgMask) };
    }
    const version = p.moduleAccess?.version || 0;
    const after = { role: p.role, status: p.status, deletedAt: p.deletedAt, moduleAccess: { ...nextAccess, version: version + 1 } };
    const before = seatMask(p);
    const now = seatMask(after);
    plans.push({ id: p._id, version, access: after.moduleAccess, gained: now & ~before, lost: before & ~now });
    bump(gained, now & ~before);
  }
  if (!plans.length) return { changed: [], skipped: ids.length };

  await claimAll(gained);
  try {
    await User.bulkWrite(
      plans.map((pl) => ({
        updateOne: {
          filter: { _id: pl.id, "moduleAccess.version": pl.version === 0 ? { $in: [0, null] } : pl.version },
          update: { $set: { moduleAccess: pl.access } }
        }
      })),
      { ordered: false }
    );
  } catch (err) {
    await releaseAll(gained);
    throw err;
  }

  // Anyone edited by someone else in between wasn't written: give their seats back
  const written = new Set(
    (await User.find({ _id: { $in: plans.map((pl) => pl.id) } }).select("moduleAccess.version").lean())
      .filter((u) => plans.find((pl) => String(pl.id) === String(u._id)).access.version === u.moduleAccess?.version)
      .map((u) => String(u._id))
  );
  const unwritten = new Map();
  const settled = new Map();
  for (const pl of plans) {
    if (written.has(String(pl.id))) bump(settled, pl.lost);
    else bump(unwritten, pl.gained);
  }
  await releaseAll(unwritten);
  await releaseAll(settled);
  const changed = plans.filter((pl) => written.has(String(pl.id))).map((pl) => pl.id);
  return { changed, skipped: ids.length - changed.length };
};

module.exports = {
  GRANTABLE_MASK,
  bulkSetModule,
  TOGGLEABLE_MASK,
  holdsAll,
  userModuleMask,
  effectiveUserMask,
  modulesFor,
  seatMask,
  transition,
  claimAll,
  releaseAll,
  countsOf,
  seatUsage,
  recountSeats,
  resolveKeys
};
