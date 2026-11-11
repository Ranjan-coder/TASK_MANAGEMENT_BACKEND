const mongoose = require("mongoose");
const tenantPlugin = require("../../../models/plugins/tenant.plugin");
const { encryptedSchema } = require("./encrypted");

/**
 * A meeting invite (planner-module-plan.md, Phase 5).
 *
 * Readable to the server: times, organiser, who is invited and their answers (it
 * schedules, checks clashes and notifies). Encrypted: title, agenda, link and
 * place, with a per-meeting key that the organiser's browser wraps separately for
 * each attendee (ECDH between the organiser's and the attendee's chat keys, as in
 * group chat). Removing someone makes the organiser's browser pick a new key
 * (`keyEpoch`), so they can't read later changes.
 *
 * One reminder per meeting (`reminderAt`), claimed atomically by the scheduler and
 * sent to every attendee who hasn't declined: no reminder rows per person.
 */
const RESPONSES = ["pending", "accepted", "tentative", "declined"];
const WRAPPED = /^[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/;

const attendeeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    response: { type: String, enum: RESPONSES, default: "pending" },
    // The meeting key, wrapped for this person (only they can unwrap it)
    wrapped: { type: String, required: true, maxlength: 200, match: WRAPPED },
    recipientKeyVersion: { type: Number, required: true, min: 1 }, // their key that unwraps it
    senderKeyVersion: { type: Number, required: true, min: 1 } // the organiser's key used to wrap it
  },
  { _id: false }
);

const meetingSchema = new mongoose.Schema(
  {
    organiser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timeZone: { type: String, required: true, maxlength: 64, default: "Asia/Kolkata" },
    enc: { type: encryptedSchema(8 * 1024), required: true },
    // The organiser is always the first attendee (holds their own wrap, response "accepted")
    attendees: { type: [attendeeSchema], validate: (v) => v.length >= 1 && v.length <= 51 },
    keyEpoch: { type: Number, default: 1 },
    reminderMinutes: { type: Number, min: 0, max: 1440, default: 10 },
    reminderAt: { type: Date, default: null },
    reminderSent: { type: Boolean, default: false },
    leaseUntil: { type: Date, default: null },
    lastUpdateNoticeAt: { type: Date, default: null },
    cancelled: { type: Boolean, default: false },
    version: { type: Number, default: 1 }
  },
  { timestamps: true }
);

meetingSchema.index({ "attendees.user": 1, startAt: 1 }); // "my meetings" and clash checks
meetingSchema.index({ organiser: 1, startAt: 1 });
meetingSchema.index({ reminderSent: 1, reminderAt: 1 }); // the scheduler
meetingSchema.plugin(tenantPlugin);

module.exports = mongoose.model("Meeting", meetingSchema);
module.exports.RESPONSES = RESPONSES;
