const mongoose = require("mongoose");

/** A customer's 1–5 star rating of their lead designer on one project (editable). */
const TAGS = ["responsive", "creative", "professional", "knowledgeable"];

const ratingSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    designer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    stars: { type: Number, required: true, min: 1, max: 5 },
    tags: { type: [{ type: String, enum: TAGS }], default: [] },
    comment: { type: String, maxlength: 1000, default: "" },
    projectStatusAtRating: { type: String, default: "active" }
  },
  { timestamps: true }
);

ratingSchema.index({ customer: 1, designer: 1, conversation: 1 }, { unique: true });
ratingSchema.index({ designer: 1, updatedAt: -1 });

module.exports = mongoose.model("Rating", ratingSchema);
module.exports.TAGS = TAGS;
