const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

/**
 * A message someone saved for later (chat-features-plan.md CH-P). Private to
 * that person. Holds ids only: the message stays encrypted and is decrypted
 * by their app when shown.
 */
const starredMessageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    message: { type: mongoose.Schema.Types.ObjectId, ref: "Message", required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true }
  },
  { timestamps: true }
);

starredMessageSchema.index({ user: 1, message: 1 }, { unique: true });
// "Starred" list, newest first, keyset-paged by _id
starredMessageSchema.index({ user: 1, _id: -1 });

starredMessageSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("StarredMessage", starredMessageSchema);
