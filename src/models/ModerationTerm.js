const mongoose = require("mongoose");

/** One entry in the abuse word list. `term` is stored normalised (see utils/moderationText). */
const moderationTermSchema = new mongoose.Schema(
  {
    term: { type: String, required: true, unique: true, maxlength: 80 },
    display: { type: String, required: true, maxlength: 80 },
    severity: { type: String, enum: ["mild", "abusive", "threat"], required: true },
    language: { type: String, enum: ["en", "hi", "hinglish", "other"], default: "other" },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ModerationTerm", moderationTermSchema);
