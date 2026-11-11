const Organisation = require("../models/Organisation");
const modules = require("../config/modules");
const { runInOrg } = require("./tenantContext");
const logger = require("./logger");

/**
 * Runs a background job once per active organisation, each run scoped to that
 * organisation. With `module`, organisations that don't have that module (off,
 * ended, or missing what it needs) are skipped. One organisation's failure never
 * stops the others. Returns the sum of the numbers the job returns.
 */
const forEachOrg = async (label, fn, { module } = {}) => {
  const { computeEntitlements } = require("../services/organisation.service");
  const orgs = await Organisation.find({ status: "active" }).select("_id status modules entitlementVersion").lean();
  const bit = module ? modules.BIT[module] : 0;
  let total = 0;
  for (const org of orgs) {
    if (bit && !(computeEntitlements(org).mask & bit)) continue;
    try {
      const n = await runInOrg(org._id, () => fn(org._id));
      if (typeof n === "number") total += n;
    } catch (err) {
      logger.error(`[${label}] organisation ${org._id} failed: ${err.message}`);
    }
  }
  return total;
};

module.exports = { forEachOrg };
