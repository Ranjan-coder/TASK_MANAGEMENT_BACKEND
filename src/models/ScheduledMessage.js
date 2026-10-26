const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

/**
 * A text message written now and sent later (chat-features-plan.md P4).
 * The sender's app encrypts it when it's written; the server holds only the
 * ciphertext and the checked fields, and posts it at `sendAt` through the
 * normal send path (franking is stamped then).
 */
const scheduledMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sendAt: { type: Date, required: true },
    status: { type: String, enum: ["pending", "sent", "cancelled", "failed"], default: "pending" },
    // Fields checked by prepareTextMessage when it was scheduled
    fields: {
      ciphertext: { type: String, required: true },
      iv: { type: String, required: true },
      replyTo: { type: mongoose.Schema.Types.ObjectId, default: null },
      keyRef: { type: { g: Number, s: Number, r: Number }, default: undefined, _id: false },
      commitment: { type: String, default: undefined },
      moderation: { type: { flagged: Boolean, severity: String, hitCount: Number }, default: undefined, _id: false },
      mentions: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
      mentionsAll: { type: String, enum: ["everyone", "here"], default: undefined },
      threadRoot: { type: mongoose.Schema.Types.ObjectId, default: null },
      alsoInChat: { type: Boolean, default: false }
    },
    // Release: claimed with a short lease so two servers never send it twice
    leaseUntil: { type: Date, default: null },
    sentMessage: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },
    error: { type: String, default: "" }
  },
  { timestamps: true }
);

scheduledMessageSchema.index({ status: 1, sendAt: 1 });
scheduledMessageSchema.index({ sender: 1, conversation: 1, status: 1 });

scheduledMessageSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("ScheduledMessage", scheduledMessageSchema);
