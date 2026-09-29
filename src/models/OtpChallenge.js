const mongoose = require("mongoose");

/**
 * One OTP sent to a phone. The code itself is never stored — only an HMAC of it.
 * Documents are purged automatically 24h after creation (TTL index).
 */
const otpChallengeSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    purpose: { type: String, enum: ["verify_phone", "reset_password"], required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    // Set when too many wrong codes are entered; blocks new sends and verifies
    lockedUntil: { type: Date, default: null },
    ipAddress: { type: String, default: "unknown" }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

otpChallengeSchema.index({ phone: 1, createdAt: -1 });
otpChallengeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model("OtpChallenge", otpChallengeSchema);
