const mongoose = require("mongoose");

/**
 * App-wide settings (one document, key "global"): business hours for the
 * reply timers, holidays, timer thresholds and the escalation contacts.
 */
const holidaySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    name: { type: String, trim: true, maxlength: 80, default: "" }
  },
  { _id: false }
);

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "global" },
    businessHours: {
      start: { type: String, default: "10:00", match: /^\d{2}:\d{2}$/ },
      end: { type: String, default: "19:00", match: /^\d{2}:\d{2}$/ },
      // 0 = Sunday … 6 = Saturday. Default: Tuesday–Sunday (Monday is the designers' day off)
      workDays: { type: [Number], default: [0, 2, 3, 4, 5, 6] },
      utcOffsetMinutes: { type: Number, default: 330 } // IST
    },
    holidays: { type: [holidaySchema], default: [] },
    sla: {
      autoReplyMin: { type: Number, default: 15 },
      remindMin: { type: Number, default: 60 },
      escalateMin: { type: Number, default: 120 }
    },
    // Abuse alert: this many flagged words within the last `window` text messages
    moderation: {
      threshold: { type: Number, default: 5 },
      window: { type: Number, default: 50 }
    },
    // Extra people told when a customer waits past the escalation threshold
    // (admin@bonito.in is always included; see settings.service)
    escalationContacts: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    retentionRunAt: { type: Date, default: null },
    // Shown to customers on their payment page and receipts (R9)
    payments: {
      companyName: { type: String, trim: true, maxlength: 120, default: "" },
      companyAddress: { type: String, trim: true, maxlength: 300, default: "" },
      gstin: { type: String, trim: true, maxlength: 15, default: "" },
      upiId: { type: String, trim: true, maxlength: 60, default: "" },
      bankName: { type: String, trim: true, maxlength: 80, default: "" },
      accountName: { type: String, trim: true, maxlength: 80, default: "" },
      accountNumber: { type: String, trim: true, maxlength: 30, default: "" },
      ifsc: { type: String, trim: true, maxlength: 11, default: "" },
      instructions: { type: String, trim: true, maxlength: 500, default: "" },
      payeeChangedAt: { type: Date, default: null } // customers are shown a notice for 14 days
    },
    referrals: {
      enabled: { type: Boolean, default: true },
      referrerReward: { type: String, trim: true, maxlength: 120, default: "₹5,000 off your next Bonito order" },
      friendReward: { type: String, trim: true, maxlength: 120, default: "₹2,000 off their first project" },
      terms: { type: String, trim: true, maxlength: 600, default: "The reward is given once your friend's project starts and their first payment is received." }
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Setting", settingSchema);
