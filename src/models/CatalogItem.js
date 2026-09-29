const mongoose = require("mongoose");

/** A product or service shown to customers (e.g. "Modular kitchen — L-shape"). */
const catalogItemSchema = new mongoose.Schema(
  {
    // portfolio = a finished Bonito project (R6): images are the "after" photos, beforeImage the starting point
    kind: { type: String, enum: ["product", "service", "portfolio"], required: true },
    category: { type: String, required: true, trim: true, maxlength: 50 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 140 },
    summary: { type: String, trim: true, maxlength: 200, default: "" },
    description: { type: String, trim: true, maxlength: 3000, default: "" }, // plain text
    images: {
      type: [
        {
          url: { type: String, required: true },
          publicId: { type: String, required: true },
          width: Number,
          height: Number,
          _id: false
        }
      ],
      default: []
    },
    beforeImage: { type: { url: String, publicId: String, width: Number, height: Number }, default: undefined, _id: false },
    location: { type: String, trim: true, maxlength: 60, default: "" },
    startingPrice: { type: Number, min: 0, max: 1_000_000_000, default: null }, // INR
    priceUnit: { type: String, trim: true, maxlength: 30, default: "" }, // e.g. "per sq ft", "onwards"
    features: { type: [String], default: [] },
    order: { type: Number, default: 0 },
    featured: { type: Boolean, default: false },
    isPublished: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

catalogItemSchema.index({ isPublished: 1, kind: 1, category: 1, order: 1 });

module.exports = mongoose.model("CatalogItem", catalogItemSchema);
