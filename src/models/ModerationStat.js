const mongoose = require("mongoose");

/** Anonymous daily counters (e.g. messages people chose not to send after the warning). No user ids. */
const moderationStatSchema = new mongoose.Schema(
  { day: { type: String, required: true, unique: true }, prevented: { type: Number, default: 0 }, sentAnyway: { type: Number, default: 0 } },
  { versionKey: false }
);

module.exports = mongoose.model("ModerationStat", moderationStatSchema);
