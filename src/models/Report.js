const mongoose = require("mongoose");

/**
 * A report about someone in a project chat: a customer reporting a Bonito
 * staff member, or a staff member flagging a customer (plan §6.1, §6.3).
 */
const REASONS = {
  customer_to_staff: ["rude", "slow_responses", "unprofessional", "poor_quality", "harassment", "other"],
  staff_to_customer: ["abusive_language", "threats", "harassment", "inappropriate_requests", "other"]
};
const ALL_REASONS = [...new Set(Object.values(REASONS).flat())];
const STATUSES = ["submitted", "under_review", "action_taken", "dismissed"];
const ACTIONS = ["note", "warning", "reassign", "suspension"];

const evidenceMessageSchema = new mongoose.Schema(
  {
    message: { type: mongoose.Schema.Types.ObjectId, ref: "Message", required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, maxlength: 4000 },
    sentAt: { type: Date, required: true },
    edited: { type: Boolean, default: false },
    verified: { type: Boolean, required: true } // franking check passed
  },
  { _id: false }
);

const attachmentSchema = new mongoose.Schema(
  { publicId: { type: String, required: true }, width: Number, height: Number, bytes: Number },
  { _id: false }
);

const noteSchema = new mongoose.Schema(
  { by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, text: { type: String, maxlength: 2000 }, at: { type: Date, default: Date.now } },
  { _id: false }
);

const reportSchema = new mongoose.Schema(
  {
    ticketNo: { type: Number, required: true, unique: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    direction: { type: String, enum: Object.keys(REASONS), required: true },
    reason: { type: String, enum: ALL_REASONS, required: true },
    description: { type: String, required: true, minlength: 20, maxlength: 2000 },
    attachments: { type: [attachmentSchema], default: [] },
    evidenceMessages: { type: [evidenceMessageSchema], default: [] },

    status: { type: String, enum: STATUSES, default: "submitted" },
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    notes: { type: [noteSchema], default: [] }, // internal, admins only

    // The reported person may respond once an admin asks them to
    responseRequestedAt: { type: Date, default: null },
    response: { text: { type: String, maxlength: 2000 }, at: Date },

    evidencePurgedAt: { type: Date, default: undefined }, // retention: evidence removed 1 year after closing
    resolution: {
      action: { type: String, enum: [...ACTIONS, null], default: null },
      note: { type: String, maxlength: 2000 }, // internal
      at: Date,
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
    }
  },
  { timestamps: true }
);

reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ reportedUser: 1, createdAt: -1 });
reportSchema.index({ reporter: 1, createdAt: -1 });
reportSchema.index({ conversation: 1 });

const Report = mongoose.model("Report", reportSchema);
module.exports = Report;
module.exports.REASONS = REASONS;
module.exports.STATUSES = STATUSES;
module.exports.ACTIONS = ACTIONS;
