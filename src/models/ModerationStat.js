const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

/** Anonymous daily counters (e.g. messages people chose not to send after the warning). No user ids. */
const moderationStatSchema = new mongoose.Schema(
  { day: { type: String, required: true }, prevented: { type: Number, default: 0 }, sentAnyway: { type: Number, default: 0 } },
  { versionKey: false }
);

moderationStatSchema.index({ orgId: 1, day: 1 }, { unique: true });
moderationStatSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("ModerationStat", moderationStatSchema);
