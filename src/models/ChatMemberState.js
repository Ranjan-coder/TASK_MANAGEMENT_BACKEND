const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

/**
 * One person's private settings for one chat (chat-features-plan.md CH-M, CH-P):
 * unread mentions and notification choices. Kept out of Conversation.members
 * because members are shown to everyone in the chat, and these are nobody
 * else's business. Created on first use; no row means the defaults.
 */
const chatMemberStateSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Messages mentioning this person since they last read the chat
    mentionCount: { type: Number, default: 0, min: 0 },
    // all = every message; mentions = only when mentioned; off = nothing
    notify: { type: String, enum: ["all", "mentions", "off"], default: "all" },
    // Snoozed until this time (everything, mentions included)
    mutedUntil: { type: Date, default: null }
  },
  { timestamps: true }
);

chatMemberStateSchema.index({ conversation: 1, user: 1 }, { unique: true });
chatMemberStateSchema.index({ user: 1 });

chatMemberStateSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("ChatMemberState", chatMemberStateSchema);
