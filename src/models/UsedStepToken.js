const mongoose = require("mongoose");

/**
 * Step tokens that have been used (module-access-plan.md, Phase 5 review): makes a
 * short-lived token single-use. The unique jti turns a second use into a duplicate
 * key error; documents expire with the token (TTL), so the collection stays small.
 * Not organisation-scoped: these tokens are used before an organisation is chosen.
 */
const usedStepTokenSchema = new mongoose.Schema(
  {
    jti: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true }
  },
  { versionKey: false }
);
usedStepTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("UsedStepToken", usedStepTokenSchema);
