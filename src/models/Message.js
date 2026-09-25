const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    originalName: { type: String, required: true },
    fileType: {
      type: String,
      enum: ["pdf", "doc", "docx", "xls", "xlsx", "image", "other"],
      required: true
    },
    mimeType: { type: String, default: "application/octet-stream" },
    fileSize: { type: Number, default: 0 },
    url: { type: String, required: true },          // Cloudinary URL (encrypted file stored here)
    publicId: { type: String, default: "" },
    thumbnailUrl: { type: String, default: null },   // Cloudinary eager transform (images)
    // E2E: file content key, encrypted with conversation session/group key
    encryptedFileKey: { type: String, default: null },
    fileIv: { type: String, default: null }          // IV used to encrypt the file bytes
  },
  { _id: false }
);

const reactionSchema = new mongoose.Schema(
  {
    emoji: { type: String, required: true, maxlength: 8 },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    type: {
      type: String,
      enum: ["text", "image", "file", "system"],
      default: "text"
    },

    // ── E2E Encrypted fields ──────────────────────────────────────────────────
    // For type "text"/"image"/"file": content is stored as AES-256-GCM ciphertext
    // For type "system": content is plain text (join/leave events — not sensitive)
    ciphertext: {
      type: String,
      default: null   // base64-encoded AES-256-GCM output (server never decrypts)
    },
    iv: {
      type: String,
      default: null   // base64-encoded 12-byte nonce (not secret, needed for decryption)
    },
    // ─────────────────────────────────────────────────────────────────────────

    // Plain text only for system messages (join/leave/rename events)
    content: {
      type: String,
      default: null
    },

    attachments: [attachmentSchema],

    // Reply-to reference
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null
    },

    reactions: [reactionSchema],

    isEdited: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false }   // soft delete — shows "Message deleted"
  },
  { timestamps: true }
);

// Indexes for pagination and lookup
messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ sender: 1 });
messageSchema.index({ conversation: 1, isDeleted: 1 });

const Message = mongoose.model("Message", messageSchema);
module.exports = Message;
