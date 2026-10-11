const modules = require("../config/modules");
const { moduleForPath } = require("../config/moduleRoutes");
const { normalisePath } = require("./accessPolicy");
const { ROLES, PLATFORM_OWNER } = require("../config/roles");
const { effectiveUserMask } = require("../services/moduleAccess.service");

/**
 * Module gate (module-access-plan.md, Phase 3), run by authMiddleware on every
 * authenticated request after the role policy:
 *
 *   1. Which module is this path? (prefix trie, O(path segments))
 *   2. Does the organisation have it, and was this person given it?
 *      effectiveMask(orgMask & userMask): two ANDs and one pass over the modules
 *
 * Deny by default: an unmapped path is refused. Customers additionally need the
 * customer portal for anything beyond signing in / out.
 */
const deny = (code, message, extra = {}) => ({ allowed: false, code, message, ...extra });
const ALLOW = Object.freeze({ allowed: true });
const PORTAL = modules.BIT.customer_portal;

/** Pure check (tested directly). `orgMask` comes from organisation.service.getEntitlements. */
const checkModuleAccess = ({ user, originalUrl, orgMask, customerMask = 0 }) => {
  // The product owner has no organisation; their routes are role-gated (accessPolicy + router)
  if (user.role === PLATFORM_OWNER && !user.orgId) return ALLOW;

  const path = normalisePath(originalUrl);
  const key = moduleForPath(path);
  if (!key) return deny("ROUTE_UNMAPPED", "This feature isn't available.");

  if (user.role === ROLES.CUSTOMER && !(orgMask & PORTAL) && !path.startsWith("/auth")) {
    return deny("MODULE_DISABLED", "The customer portal isn't available for your organisation.", { module: "customer_portal" });
  }
  if (!(orgMask & modules.BIT[key])) {
    return deny("MODULE_DISABLED", `${modules.getModule(key).label} isn't available for your organisation.`, { module: key });
  }
  if (!(effectiveUserMask(user, orgMask, customerMask) & modules.BIT[key])) {
    return deny("MODULE_NOT_GRANTED", `You haven't been given access to ${modules.getModule(key).label}. Ask your superadmin.`, { module: key });
  }
  return ALLOW;
};

module.exports = { checkModuleAccess };
