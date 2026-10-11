const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

/** A customer's request to delete their account and personal data (DPDP Act, R8). */
const deletionRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["pending", "cancelled", "completed", "rejected"], default: "pending" },
    reason: { type: String, trim: true, maxlength: 1000, default: "" },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    handledAt: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: 1000, default: "" }, // shown to the customer if rejected
    // Kept after deletion as proof the request was honoured (no personal data)
    summary: { type: Object, default: undefined }
  },
  { timestamps: true }
);

deletionRequestSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_request" });
deletionRequestSchema.index({ status: 1, createdAt: 1 });

deletionRequestSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("DeletionRequest", deletionRequestSchema);
