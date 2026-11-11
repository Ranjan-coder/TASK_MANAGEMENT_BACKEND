const mongoose = require("mongoose");
const tenantPlugin = require("../../../models/plugins/tenant.plugin");
const { encryptedSchema } = require("./encrypted");
const { FREQS } = require("../recurrence");

/**
 * A reminder. The text is encrypted; the time and repeat rule stay readable because
 * the server has to fire it. `anchorAt` is the scheduled occurrence, `nextAt` when
 * to fire (later than anchorAt only while snoozed), so repeats never drift.
 * `leaseUntil` lets one server claim it while sending (see reminders.service).
 */
const recurrenceSchema = new mongoose.Schema(
  {
    freq: { type: String, enum: FREQS, default: "none" },
    interval: { type: Number, min: 1, max: 30, default: 1 },
    byWeekday: { type: [{ type: Number, min: 0, max: 6 }], default: [] },
    monthDay: { type: Number, min: 1, max: 31, default: null }
  },
  { _id: false }
);

const reminderSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    enc: { type: encryptedSchema(1024), required: true },
    anchorAt: { type: Date, required: true },
    nextAt: { type: Date, required: true },
    timeZone: { type: String, required: true, maxlength: 64, default: "Asia/Kolkata" },
    recurrence: { type: recurrenceSchema, default: () => ({}) },
    status: { type: String, enum: ["active", "done"], default: "active" },
    leaseUntil: { type: Date, default: null },
    lastFiredAt: { type: Date, default: null },
    // Optional link to the thing it is about (a note, a todo item, a meeting)
    link: {
      kind: { type: String, enum: ["note", "item", "meeting", null], default: null },
      id: { type: mongoose.Schema.Types.ObjectId, default: null }
    },
    version: { type: Number, default: 1 }
  },
  { timestamps: true }
);

reminderSchema.index({ status: 1, nextAt: 1 }); // the scheduler: due reminders, oldest first
reminderSchema.index({ owner: 1, status: 1, nextAt: 1 }); // the person's lists
reminderSchema.index({ "link.kind": 1, "link.id": 1 }); // meeting reminders follow their meeting
reminderSchema.plugin(tenantPlugin);

module.exports = mongoose.model("Reminder", reminderSchema);
