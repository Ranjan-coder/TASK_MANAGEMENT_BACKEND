const mongoose = require("mongoose");

/**
 * An offer, campaign video or poster shown on the customer Home page.
 * Visibility = status "published" AND now within [startAt, endAt).
 */
const campaignSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: "" }, // plain text
    kind: { type: String, enum: ["video", "image", "offer"], required: true },
    media: {
      type: {
        url: { type: String, required: true },
        publicId: { type: String, required: true },
        resourceType: { type: String, enum: ["image", "video"], required: true },
        posterUrl: { type: String, default: null },
        width: Number,
        height: Number,
        duration: Number, // seconds (videos)
        bytes: Number
      },
      default: undefined,
      _id: false
    },
    offer: {
      type: {
        badge: { type: String, trim: true, maxlength: 30 }, // e.g. "Flat 20% off"
        terms: { type: String, trim: true, maxlength: 500 }
      },
      default: undefined,
      _id: false
    },
    cta: {
      type: { type: String, enum: ["none", "consultation", "call", "whatsapp", "link"], default: "none" },
      label: { type: String, trim: true, maxlength: 30, default: "" },
      value: { type: String, trim: true, maxlength: 500, default: "" }
    },
    startAt: { type: Date, required: true },
    endAt: { type: Date, default: null },
    priority: { type: Number, min: 0, max: 100, default: 50 },
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
    targetCities: { type: [String], default: [] },
    stats: {
      impressions: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      leads: { type: Number, default: 0 }
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

campaignSchema.index({ status: 1, startAt: 1, endAt: 1, priority: -1 });

/** "draft" | "scheduled" | "live" | "expired" | "archived" */
campaignSchema.methods.state = function (now = new Date()) {
  if (this.status !== "published") return this.status;
  if (this.startAt > now) return "scheduled";
  if (this.endAt && this.endAt <= now) return "expired";
  return "live";
};

module.exports = mongoose.model("Campaign", campaignSchema);
