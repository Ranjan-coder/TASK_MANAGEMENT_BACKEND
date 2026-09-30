const ApiError = require("../utils/ApiError");
const { hasPermission } = require("../config/permissions");

/**
 * Route guard: allowed if the person's role is in `roles`, or they hold any of
 * `permissions` (a superadmin-granted add-on, or implied by their role, e.g.
 * leadership). Use instead of rbacMiddleware where add-on permissions apply.
 *   authorize(ADMIN_ROLES, "payments.view", "payments.confirm")
 */
const authorize = (roles, ...permissions) => (req, res, next) => {
  const user = req.user;
  if (user && (roles.includes(user.role) || permissions.some((p) => hasPermission(user, p)))) return next();
  return next(new ApiError(403, "Forbidden: You do not have permission to perform this action"));
};

module.exports = authorize;
