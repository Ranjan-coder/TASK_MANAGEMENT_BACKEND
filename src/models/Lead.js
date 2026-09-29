const mongoose = require("mongoose");

/** A customer asked for a consultation from a campaign's call-to-action. */
const leadSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null },
    message: { type: String, trim: true, maxlength: 500, default: "" },
    status: { type: String, enum: ["new", "contacted", "converted", "closed"], default: "new" },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    contactedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    notes: {
      type: [{ by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, text: { type: String, maxlength: 1000 }, at: { type: Date, default: Date.now }, _id: false }],
      default: []
    }
  },
  { timestamps: true }
);

// One open request per customer per campaign
leadSchema.index(
  { customer: 1, campaign: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["new", "contacted"] } } }
);
leadSchema.index({ status: 1, createdAt: -1 });
// The partial unique index above can't serve plain customer / campaign lookups
leadSchema.index({ customer: 1, createdAt: -1 });
leadSchema.index({ campaign: 1, createdAt: -1 });

module.exports = mongoose.model("Lead", leadSchema);
