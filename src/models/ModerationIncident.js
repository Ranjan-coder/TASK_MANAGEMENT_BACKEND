const mongoose = require("mongoose");

/**
 * An abuse alert in a project chat: raised when flagged words sent with
 * "Send anyway" reach the threshold in the recent-message window, or at once
 * for a threat. Holds only counts and who sent them — never message text.
 */
const offenderSchema = new mongoose.Schema(
  { user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, hits: { type: Number, default: 0 }, messages: { type: Number, default: 0 } },
  { _id: false }
);

const moderationIncidentSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    trigger: { type: String, enum: ["threshold", "threat"], required: true },
    severity: { type: String, enum: ["mild", "abusive", "threat"], required: true },
    hitCount: { type: Number, default: 0 }, // flagged words since the window started
    windowSize: { type: Number, default: 50 },
    threshold: { type: Number, default: 5 },
    offenders: { type: [offenderSchema], default: [] },
    firstFlagAt: { type: Date, default: null },
    lastFlagAt: { type: Date, default: null },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    evidenceRequestedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, maxlength: 2000, default: "" }
  },
  { timestamps: true }
);

moderationIncidentSchema.index({ status: 1, createdAt: -1 });
moderationIncidentSchema.index({ conversation: 1, createdAt: -1 });
moderationIncidentSchema.index({ createdAt: -1 });

module.exports = mongoose.model("ModerationIncident", moderationIncidentSchema);
