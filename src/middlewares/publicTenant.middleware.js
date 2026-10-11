const { runWithStore } = require("../utils/tenantContext");

/**
 * Public sign-in routes: the request starts without an organisation (the account
 * isn't known yet). Lookups run across organisations; once the account is found
 * the controller narrows the request to its organisation (setOrg). Authenticated
 * routes mounted on the same router replace this with the user's organisation.
 */
const publicTenant = (req, res, next) => {
  req.tenant = { system: true, resolvable: true };
  runWithStore(req.tenant, () => next());
};

module.exports = publicTenant;
