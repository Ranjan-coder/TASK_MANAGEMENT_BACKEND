const mongoose = require("mongoose");

/**
 * A browser/phone registered for web push. Tied to the sign-in session that
 * created it: once that session is signed out, the device stops getting pushes.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sessionId: { type: String, required: true },
    endpoint: { type: String, required: true, unique: true, maxlength: 1000 },
    keys: {
      p256dh: { type: String, required: true, maxlength: 200 },
      auth: { type: String, required: true, maxlength: 100 }
    },
    deviceName: { type: String, default: "", maxlength: 120 },
    lastSuccessAt: { type: Date, default: null }
  },
  { timestamps: true }
);

pushSubscriptionSchema.index({ user: 1 });

module.exports = mongoose.model("PushSubscription", pushSubscriptionSchema);
