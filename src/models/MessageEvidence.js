const mongoose = require("mongoose");

/**
 * Original (still end-to-end encrypted) content of project-chat messages that
 * were edited or deleted. Never returned by chat endpoints; kept so a verified
 * report can show what was really said (Phase 5). Purged after one year.
 */
const messageEvidenceSchema = new mongoose.Schema(
  {
    message: { type: mongoose.Schema.Types.ObjectId, ref: "Message", required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, enum: ["edited", "deleted"], required: true },
    ciphertext: { type: String, default: null },
    iv: { type: String, default: null },
    keyRef: { type: Object, default: undefined },
    franking: { type: Object, default: undefined },
    attachments: { type: Array, default: [] },
    originalCreatedAt: { type: Date, required: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

messageEvidenceSchema.index({ message: 1, createdAt: 1 });
messageEvidenceSchema.index({ conversation: 1, createdAt: -1 });
messageEvidenceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model("MessageEvidence", messageEvidenceSchema);
