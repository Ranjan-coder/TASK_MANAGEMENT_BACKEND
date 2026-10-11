const Organisation = require("../models/Organisation");
const config = require("../config/env");
const modules = require("../config/modules");
const { onInvalidate, publishInvalidate } = require("../utils/cacheBus");

/**
 * Organisation lookups used on every request: status (auth gate) and entitlements
 * (which modules the organisation may use).
 *
 * Cache: Map<orgId, { org, at, ent }>, LRU-bounded, 30 s TTL. A change clears this
 * server's entry at once and tells the other servers over Redis (utils/cacheBus);
 * without Redis the TTL covers it.
 *
 * Entitlements are a bitmask (config/modules.js). Expiry is lazy: the mask is
 * computed from the stored modules when read and remembered until the next
 * expiry moment, so no job has to sweep expired modules and a check stays O(1).
 */
const TTL_MS = 30 * 1000;
const MAX = 5000;
const TOPIC = "organisation";
const byId = new Map();

const FIELDS = "name slug displayName status entitlementVersion modules customerModules";

const load = async (orgId) => {
  if (!orgId) return null;
  const key = String(orgId);
  const hit = byId.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  // Organisation is not tenant-scoped, so this works in any context
  const org = await Organisation.findById(orgId).select(FIELDS).lean();
  const entry = { org, at: Date.now(), ent: null };
  byId.delete(key);
  byId.set(key, entry);
  if (byId.size > MAX) byId.delete(byId.keys().next().value); // oldest first (LRU)
  return entry;
};

/**
 * From the stored module list: which modules are on right now, and until when
 * that answer holds (the next expiry). Dependencies are applied by effectiveMask:
 * a module whose requirement is off doesn't count.
 */
const computeEntitlements = (org, now = Date.now()) => {
  let onMask = 0;
  let offMask = 0; // switched off explicitly (beats "on by default")
  let validUntil = Infinity;
  for (const m of org?.modules || []) {
    if (!modules.isModule(m.key)) continue;
    if (!m.enabled) {
      offMask |= modules.BIT[m.key];
      continue;
    }
    const exp = m.expiresAt ? new Date(m.expiresAt).getTime() : Infinity;
    if (exp > now) {
      onMask |= modules.BIT[m.key];
      validUntil = Math.min(validUntil, exp);
    } else {
      offMask |= modules.BIT[m.key]; // ended
    }
  }
  // Default-on modules (e.g. Planner) count unless switched off or ended
  onMask |= modules.DEFAULT_ON_MASK & ~offMask;
  const mask = org?.status === "active" ? modules.effectiveMask(onMask) : 0;
  // Staff-only modules this organisation opened to its customers (superadmin choice)
  const customerMask = mask & modules.CUSTOMER_OPT_IN_MASK & modules.toMask(org?.customerModules || []);
  return { mask, customerMask, validUntil, version: org?.entitlementVersion || 0 };
};

/** Slug from the cache only (sync; the auth gate has just loaded it). Null if not cached. */
const getCachedSlug = (orgId) => byId.get(String(orgId))?.org?.slug || null;

/** "active", "suspended" or "missing". Used by the auth gate. */
const getOrgStatus = async (orgId) => (await load(orgId))?.org?.status || "missing";

/** Bitmask of the modules this organisation may use now (core always included). */
const getEntitlements = async (orgId) => {
  const entry = await load(orgId);
  if (!entry?.org) return { mask: 0, customerMask: 0, version: 0 };
  const now = Date.now();
  if (!entry.ent || now >= entry.ent.validUntil) entry.ent = computeEntitlements(entry.org, now);
  return entry.ent;
};

const orgHasModule = async (orgId, key) => ((await getEntitlements(orgId)).mask & (modules.BIT[key] || 0)) !== 0;

/** Map<moduleKey, seatLimit|null> for an organisation (from the cached entry). */
const getSeatLimits = async (orgId) => {
  const entry = await load(orgId);
  return new Map((entry?.org?.modules || []).map((m) => [m.key, m.seatLimit ?? null]));
};

/**
 * The name to show in place of the product name: the organisation's display name
 * while it has the branding module, otherwise null (the app shows the product name).
 */
const brandNameOf = (org, mask) => (org?.displayName && mask & modules.BIT.branding ? org.displayName : null);

/** What the app shows about the user's organisation (name, slug, brand name and its modules). */
const getPublicOrg = async (orgId) => {
  const entry = await load(orgId);
  if (!entry?.org) return null;
  const { mask } = await getEntitlements(orgId);
  return { _id: entry.org._id, name: entry.org.name, slug: entry.org.slug, brandName: brandNameOf(entry.org, mask), modules: modules.fromMask(mask) };
};

/** The app's name as the current organisation's people see it (push titles, 2FA app entry). */
const currentBrandName = async () => {
  const { currentOrgId } = require("../utils/tenantContext");
  const id = currentOrgId();
  if (!id) return config.appName;
  const entry = await load(id);
  return brandNameOf(entry?.org, (await getEntitlements(id)).mask) || config.appName;
};

/** The current organisation's name, for messages people receive (never hard-coded). */
const currentOrgName = async (fallback = "your organisation") => {
  const { currentOrgId } = require("../utils/tenantContext");
  const id = currentOrgId();
  return (id && (await load(id))?.org?.name) || fallback;
};

/** Many organisations at once (sign-in chooser): one query, returned as a Map. */
const getManyPublic = async (orgIds) => {
  const ids = [...new Set(orgIds.map(String))];
  const rows = await Organisation.find({ _id: { $in: ids } }).select("name slug status").lean();
  return new Map(rows.map((o) => [String(o._id), o]));
};

const findActiveBySlug = (slug) =>
  Organisation.findOne({ slug: String(slug || "").trim().toLowerCase(), status: "active" }).select("_id name slug").lean();

/** Clears this server's copy and tells the others. Call after every organisation change. */
const invalidate = (orgId) => {
  byId.delete(String(orgId));
  publishInvalidate(TOPIC, orgId);
};
onInvalidate(TOPIC, (id) => byId.delete(String(id)));

module.exports = {
  getOrgStatus,
  getEntitlements,
  orgHasModule,
  getSeatLimits,
  getCachedSlug,
  computeEntitlements,
  getPublicOrg,
  brandNameOf,
  currentBrandName,
  currentOrgName,
  getManyPublic,
  findActiveBySlug,
  invalidate
};
