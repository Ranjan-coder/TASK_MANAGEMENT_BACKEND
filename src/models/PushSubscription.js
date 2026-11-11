const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

/**
 * A browser/phone registered for web push. Tied to the sign-in session that
 * created it: once that session is signed out, the device stops getting pushes.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sessionId: { type: String, required: true },
    endpoint: { type: String, required: true, maxlength: 1000 },
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
pushSubscriptionSchema.index({ orgId: 1, endpoint: 1 }, { unique: true });

pushSubscriptionSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("PushSubscription", pushSubscriptionSchema);
