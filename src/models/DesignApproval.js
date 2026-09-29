const mongoose = require("mongoose");

/**
 * A design sign-off in a project chat (R4): the designer asks for approval on
 * a design they posted (image or file message), the customer approves or asks
 * for changes. The record pins the exact encrypted upload and the time, so
 * "I never approved this" can be settled. Title and comment are plain text
 * (visible to Bonito admins) because they form the sign-off record.
 */
const designApprovalSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    message: { type: mongoose.Schema.Types.ObjectId, ref: "Message", required: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // What was approved: the encrypted file stored for that message
    attachment: {
      publicId: { type: String, default: "" },
      originalName: { type: String, default: "" },
      fileSize: { type: Number, default: 0 },
      messageCreatedAt: { type: Date }
    },
    status: { type: String, enum: ["pending", "approved", "changes_requested", "withdrawn"], default: "pending" },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    comment: { type: String, trim: true, maxlength: 1000, default: "" }
  },
  { timestamps: true }
);

designApprovalSchema.index({ conversation: 1, createdAt: -1 });
designApprovalSchema.index({ message: 1 }, { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_per_message" });

module.exports = mongoose.model("DesignApproval", designApprovalSchema);
