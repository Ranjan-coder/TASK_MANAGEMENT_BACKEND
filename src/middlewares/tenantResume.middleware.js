const { runWithStore } = require("../utils/tenantContext");

/**
 * Wraps a stream-based middleware (multer) so that `next` continues inside the
 * request's organisation context. Busboy's stream events fire outside the async
 * context the request started in; without this the rest of the chain would have
 * no organisation and every query would refuse to run.
 */
const resumeTenant = (middleware) => (req, res, next) =>
  middleware(req, res, (err) => runWithStore(req.tenant, () => next(err)));

module.exports = resumeTenant;
