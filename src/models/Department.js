const mongoose = require("mongoose");

/**
 * A team people belong to (Tech, Sales, Designer …). Managed by superadmins only.
 * Users keep a copy of the name (User.department) for fast reads; renames and
 * merges rewrite those copies in one bulk update (org.service.js).
 */
const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Normalised name (utils/orgKey) — unique, so near-duplicates are refused
    key: { type: String, required: true, unique: true },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    head: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

departmentSchema.index({ isActive: 1, sortOrder: 1 });

module.exports = mongoose.model("Department", departmentSchema);
