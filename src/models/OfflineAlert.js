const mongoose = require("mongoose");

/**
 * "Your designer replied" alert for a customer who hasn't seen a staff reply
 * (R3/R7). Step 1 (push) after a short wait; step 2 (WhatsApp/SMS, only if
 * the customer opted in) if it's still unread. Never contains message text.
 */
const offlineAlertSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    since: { type: Date, required: true }, // first unanswered staff message
    step: { type: String, enum: ["push", "external"], default: "push" },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: ["pending", "done"], default: "pending" },
    outcome: { type: String, default: "" }, // e.g. "read", "online", "push", "whatsapp", "sms", "throttled"
    externalSentAt: { type: Date, default: null }
  },
  { timestamps: true }
);

offlineAlertSchema.index({ user: 1, conversation: 1 }, { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_alert" });
offlineAlertSchema.index({ status: 1, dueAt: 1 });
offlineAlertSchema.index({ user: 1, conversation: 1, externalSentAt: -1 });
offlineAlertSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model("OfflineAlert", offlineAlertSchema);
