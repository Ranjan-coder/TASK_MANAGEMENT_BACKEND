const mongoose = require("mongoose");

/**
 * One impression/click per customer, per campaign, per day. The unique index
 * makes repeated views/clicks free, so campaign stats can't be inflated.
 * Purged after 180 days.
 */
const campaignEventSchema = new mongoose.Schema(
  {
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["impression", "click"], required: true },
    day: { type: String, required: true } // YYYY-MM-DD (IST)
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

campaignEventSchema.index({ campaign: 1, user: 1, type: 1, day: 1 }, { unique: true });
campaignEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model("CampaignEvent", campaignEventSchema);
