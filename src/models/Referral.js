const mongoose = require("mongoose");

/**
 * A friend referred by a customer (R9).
 * signed_up → (friend verifies phone and makes a first payment) qualified →
 * rewarded by an admin; or rejected (e.g. same person, fake account).
 */
const referralSchema = new mongoose.Schema(
  {
    referrer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    referred: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    code: { type: String, required: true },
    status: { type: String, enum: ["signed_up", "qualified", "rewarded", "rejected"], default: "signed_up" },
    qualifiedAt: { type: Date, default: null },
    rewardedAt: { type: Date, default: null },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, trim: true, maxlength: 500, default: "" }
  },
  { timestamps: true }
);

referralSchema.index({ referrer: 1, createdAt: -1 });
referralSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Referral", referralSchema);
