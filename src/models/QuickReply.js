const mongoose = require("mongoose");

/**
 * Saved reply templates for staff (R5). owner = null means shared with all
 * staff (managed by admins). Inserting one only fills the message box; the
 * message itself is still end-to-end encrypted when sent.
 */
const quickReplySchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    title: { type: String, required: true, trim: true, maxlength: 60 },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

quickReplySchema.index({ owner: 1, title: 1 });

module.exports = mongoose.model("QuickReply", quickReplySchema);
