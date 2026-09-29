const mongoose = require("mongoose");

/**
 * Payment schedule for one project (R9). Amounts are whole paise (integers)
 * so there are no rounding errors. No card data or gateway here: customers
 * pay by UPI / bank transfer and tell us the reference; an admin confirms it
 * against the bank statement and a numbered receipt is issued.
 */
const claimSchema = new mongoose.Schema(
  {
    method: { type: String, enum: ["upi", "bank_transfer", "cheque", "cash", "card"], required: true },
    reference: { type: String, trim: true, maxlength: 60, default: "" },
    amountPaise: { type: Number, required: true, min: 1 },
    paidOn: { type: Date, required: true },
    note: { type: String, trim: true, maxlength: 300, default: "" },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  },
  { _id: false }
);

const milestoneSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 80 },
  amountPaise: { type: Number, required: true, min: 1 },
  dueDate: { type: Date, default: null },
  // upcoming → (customer says paid) verifying → paid; or waived by an admin
  status: { type: String, enum: ["upcoming", "verifying", "paid", "waived"], default: "upcoming" },
  claim: { type: claimSchema, default: undefined },
  lastClaimRejection: { note: String, at: Date, _id: false },
  paid: {
    amountPaise: Number,
    method: { type: String, enum: ["upi", "bank_transfer", "cheque", "cash", "card"] },
    reference: String,
    paidOn: Date,
    receiptNo: String,
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    confirmedAt: Date,
    _id: false
  },
  // Official GST invoice uploaded by accounts (private file)
  invoice: { publicId: String, fileName: String, uploadedAt: Date, _id: false },
  reminderSentAt: { type: Date, default: null },
  overdueReminderAt: { type: Date, default: null }
});

const projectFinanceSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, unique: true },
    contractValuePaise: { type: Number, required: true, min: 0 },
    gstRatePct: { type: Number, min: 0, max: 28, default: 18 }, // amounts are GST-inclusive
    milestones: { type: [milestoneSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 500, default: "" }, // shown to the customer
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  // A schedule save fails (instead of silently undoing it) if a payment changed meanwhile
  { timestamps: true, optimisticConcurrency: true }
);

projectFinanceSchema.index({ "milestones.status": 1, "milestones.dueDate": 1 });

module.exports = mongoose.model("ProjectFinance", projectFinanceSchema);
