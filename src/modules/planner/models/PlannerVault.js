const mongoose = require("mongoose");
const tenantPlugin = require("../../../models/plugins/tenant.plugin");

/**
 * A person's planner key, wrapped (encrypted) once per chat-key version they hold.
 * The key itself is made in the browser and never reaches the server unwrapped;
 * any of the person's devices with their chat keys can unwrap it. A new chat-key
 * version adds a wrap (append-only), so nothing ever needs re-encrypting.
 */
const wrapSchema = new mongoose.Schema(
  {
    keyVersion: { type: Number, required: true, min: 1 },
    wrapped: { type: String, required: true, maxlength: 200, match: /^[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/ }
  },
  { _id: false }
);

const plannerVaultSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    wraps: { type: [wrapSchema], default: [], validate: (v) => v.length <= 50 }
  },
  { timestamps: true }
);

plannerVaultSchema.index({ orgId: 1, user: 1 }, { unique: true });
plannerVaultSchema.plugin(tenantPlugin);

module.exports = mongoose.model("PlannerVault", plannerVaultSchema);
