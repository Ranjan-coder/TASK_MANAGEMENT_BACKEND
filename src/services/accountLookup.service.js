const User = require("../models/User");
const tenant = require("../utils/tenantContext");
const { findActiveBySlug } = require("./organisation.service");
const { PLATFORM_OWNER } = require("../config/roles");
const { PLATFORM_CODE } = require("../models/Organisation");

/** The product owner: outside every organisation (orgId null). */
const isPlatformUser = (user) => Boolean(user) && user.role === PLATFORM_OWNER && !user.orgId;

/**
 * Sign-in lookups across organisations (module-access-plan.md, M5): the same email
 * or phone may hold separate accounts in several organisations.
 *
 * - With an organisation code (slug) the search is limited to that organisation.
 * - Without one, a single matching account is used directly. Two or more can't be
 *   told apart, and the caller answers exactly as for an unknown account, so the
 *   response never reveals which (or how many) organisations someone belongs to.
 */
const MAX_ACCOUNTS = 10;

/** Accounts matching { email } or { phone }, optionally in one organisation. */
const findAccounts = async ({ email, phone }, { organisation, select = "", extra = {} } = {}) => {
  if (!email && !phone) return [];
  const filter = { ...extra, ...(email ? { email: String(email).toLowerCase() } : { phone }) };
  if (organisation === PLATFORM_CODE) {
    // The product owner's reserved code: platform-level accounts only
    return tenant.runAsSystem(() => User.find({ ...filter, role: PLATFORM_OWNER, orgId: null }).select(select).limit(MAX_ACCOUNTS));
  }
  if (organisation) {
    const org = await findActiveBySlug(organisation);
    if (!org) return [];
    filter.orgId = org._id;
  }
  return tenant.runAsSystem(() => User.find(filter).select(select).limit(MAX_ACCOUNTS));
};

/** The one account the request can mean, or null (none, or ambiguous). */
const findSingleAccount = async (identity, options) => {
  const accounts = await findAccounts(identity, options);
  return accounts.length === 1 ? accounts[0] : null;
};

/** Loads a user by id across organisations (tokens carry only the user id). */
const findUserById = (id, select = "") => tenant.runAsSystem(() => User.findById(id).select(select));

/**
 * Narrows the current sign-in request to this user's organisation, so everything
 * that follows (session save, audit log, notifications) is scoped to it.
 */
const enterUserOrg = (user) => (isPlatformUser(user) ? tenant.setPlatform() : tenant.setOrg(user.orgId));

/** Runs fn scoped to the account's organisation (or the platform level). */
const runAsAccount = (user, fn) => (isPlatformUser(user) ? tenant.runAsPlatform(fn) : tenant.runInOrg(user.orgId, fn));

module.exports = { findAccounts, findSingleAccount, findUserById, enterUserOrg, runAsAccount, isPlatformUser, MAX_ACCOUNTS };
