const { AsyncLocalStorage } = require("async_hooks");
const mongoose = require("mongoose");

/**
 * Which organisation the current request (or job, or socket event) belongs to.
 *
 * Every tenant-scoped model reads this in its query hooks (models/plugins/tenant.plugin.js),
 * so a query can only ever see its own organisation's data. With no context at all a
 * query throws: forgetting to set the organisation fails closed, never open.
 *
 * Store shapes:
 *   { orgId }                       normal request / job, scoped to one organisation
 *   { system: true }                cross-organisation (sign-in lookups, jobs, scripts)
 *   { system: true, resolvable }    public sign-in route: starts cross-org, then
 *                                   setOrg() narrows it once the account is known
 *   { platform: true }              the product owner: scoped to orgId null, i.e. only
 *                                   platform-level documents (their own account,
 *                                   platform audit entries). Never business data (M3);
 *                                   platform services use runAsSystem for counts.
 */
const als = new AsyncLocalStorage();

class TenantContextError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenantContextError";
    this.statusCode = 500;
  }
}

const SYSTEM = Symbol("system");

const toId = (orgId) => {
  if (!orgId) throw new TenantContextError("Organisation id is required");
  return orgId instanceof mongoose.Types.ObjectId ? orgId : new mongoose.Types.ObjectId(String(orgId));
};

/**
 * Runs fn in a store. A Mongoose query or aggregate only runs when it is awaited,
 * which would be outside the store, so one returned by fn is executed inside it.
 */
const execIn = (store, fn) =>
  als.run(store, () => {
    const result = fn();
    return result && typeof result.exec === "function" ? result.exec() : result;
  });

/** Runs fn scoped to one organisation. */
const runInOrg = (orgId, fn) => execIn({ orgId: toId(orgId) }, fn);

/** Runs fn as the product owner (orgId null). */
const runAsPlatform = (fn) => execIn({ platform: true, orgId: null }, fn);

/** Runs fn without organisation scoping. Writes must then set orgId themselves. */
const runAsSystem = (fn) => execIn({ system: true }, fn);

/** Public sign-in routes: cross-org until setOrg() is called once. */
const runResolvable = (fn) => execIn({ system: true, resolvable: true }, fn);

/**
 * Narrows a resolvable (sign-in) context to one organisation, once the account is
 * known. A context that is already scoped can never be switched to another org.
 */
const setOrg = (orgId) => {
  const store = als.getStore();
  if (!store || !store.resolvable) throw new TenantContextError("Organisation can only be set on a sign-in request");
  store.orgId = toId(orgId);
  store.system = false;
  store.resolvable = false;
};

/** Narrows a sign-in request to the platform level (the product owner signing in). */
const setPlatform = () => {
  const store = als.getStore();
  if (!store || !store.resolvable) throw new TenantContextError("Platform scope can only be set on a sign-in request");
  store.orgId = null;
  store.platform = true;
  store.system = false;
  store.resolvable = false;
};

/**
 * ObjectId of the current organisation, null for the platform level, SYSTEM, or
 * throws if there is no context.
 */
const scope = () => {
  const store = als.getStore();
  if (!store) throw new TenantContextError("No organisation context for this database query");
  if (store.system) return SYSTEM;
  if (store.platform) return null;
  if (!store.orgId) throw new TenantContextError("No organisation context for this database query");
  return store.orgId;
};

const isPlatform = () => Boolean(als.getStore()?.platform);

/** Current organisation id, or null (system / no context). Never throws. */
const currentOrgId = () => {
  const store = als.getStore();
  return store && !store.system ? store.orgId : null;
};

/** Current organisation id; throws if there isn't one. */
const requireOrgId = () => {
  const id = currentOrgId();
  if (!id) throw new TenantContextError("This action needs an organisation");
  return id;
};

const getStore = () => als.getStore();

/** Re-enters a saved store (used where streams lose the async context, e.g. multer). */
const runWithStore = (store, fn) => (store ? als.run(store, fn) : fn());

module.exports = {
  SYSTEM,
  TenantContextError,
  runInOrg,
  runAsSystem,
  runAsPlatform,
  setPlatform,
  isPlatform,
  runResolvable,
  runWithStore,
  setOrg,
  scope,
  currentOrgId,
  requireOrgId,
  getStore
};
