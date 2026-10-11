const { runWithStore } = require("./tenantContext");

// Re-enters the request's organisation context (req.tenant, set by authMiddleware)
// so a handler is scoped even if an earlier stream callback dropped the context.
const asyncHandler = (requestHandler) => {
  return (req, res, next) => {
    Promise.resolve(runWithStore(req.tenant, () => requestHandler(req, res, next))).catch((err) => next(err));
  };
};

module.exports = asyncHandler;
