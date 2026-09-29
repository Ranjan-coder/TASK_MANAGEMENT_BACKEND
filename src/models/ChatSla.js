const mongoose = require("mongoose");

/**
 * One waiting period in a project chat: from the first unanswered customer
 * message until any staff member replies. Kept after it closes for
 * response-time metrics.
 */
const chatSlaSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Lead designer at the latest step (used for per-designer metrics)
    designer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    open: { type: Boolean, default: true },

    waitingSince: { type: Date, required: true }, // the customer's message
    clockStart: { type: Date, required: true }, // same, or the next opening if sent after hours
    afterHours: { type: Boolean, default: false },

    // Deadlines in working time, fixed when the period starts
    autoReplyAt: { type: Date, required: true },
    remindAt: { type: Date, required: true },
    escalateAt: { type: Date, required: true },

    stage: { type: String, enum: ["waiting", "auto_replied", "reminded", "escalated"], default: "waiting" },
    nextCheckAt: { type: Date, default: null },

    autoRepliedAt: { type: Date, default: null },
    remindedAt: { type: Date, default: null },
    remindedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    snoozedUntil: { type: Date, default: null },
    snoozeRepeatedAt: { type: Date, default: null },
    escalatedAt: { type: Date, default: null },
    escalatedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolution: { type: String, enum: ["replied", "closed", null], default: null },
    replyWorkingMs: { type: Number, default: null } // working time the customer waited
  },
  { timestamps: true }
);

// At most one open waiting period per chat (a second concurrent insert fails)
chatSlaSchema.index({ conversation: 1 }, { unique: true, partialFilterExpression: { open: true }, name: "one_open_per_conversation" });
chatSlaSchema.index({ open: 1, nextCheckAt: 1 });
chatSlaSchema.index({ waitingSince: -1, designer: 1 });
chatSlaSchema.index({ remindedUsers: 1, open: 1 });

module.exports = mongoose.model("ChatSla", chatSlaSchema);
