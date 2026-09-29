const mongoose = require("mongoose");

/** A customer testimonial shown on the customer Home page (R6), entered by marketing/admin with the customer's permission. */
const testimonialSchema = new mongoose.Schema(
  {
    customerName: { type: String, required: true, trim: true, maxlength: 60 },
    location: { type: String, trim: true, maxlength: 60, default: "" },
    quote: { type: String, required: true, trim: true, maxlength: 600 },
    rating: { type: Number, min: 1, max: 5, default: null },
    projectType: { type: String, trim: true, maxlength: 60, default: "" }, // e.g. "3BHK full home"
    photo: { url: String, publicId: String, _id: false },
    portfolioItem: { type: mongoose.Schema.Types.ObjectId, ref: "CatalogItem", default: null },
    consentConfirmed: { type: Boolean, required: true },
    isPublished: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true }
);

testimonialSchema.index({ isPublished: 1, order: 1 });

module.exports = mongoose.model("Testimonial", testimonialSchema);
