const ApiError = require("../utils/ApiError");

const rbacMiddleware = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(
        new ApiError(403, "Forbidden: You do not have permission to perform this action")
      );
    }
    next();
  };
};

module.exports = rbacMiddleware;
