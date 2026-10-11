const mongoose = require("mongoose");
const { STAFF_ROLES } = require("../config/roles");

/**
 * The standard departments and designations, managed by the product owner
 * (services/orgTemplate.service.js). Platform-level and deliberately global: they
 * hold no organisation's data, only the starting list every organisation gets.
 *
 * Each organisation has its own copies (models/Department, models/Designation)
 * linked by `templateId`. A product-owner change reaches every copy except fields
 * that organisation changed itself (`overrides`); new items are added to every
 * organisation.
 */

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    key: { type: String, required: true, unique: true }, // normalised name (utils/orgKey)
    description: { type: String, trim: true, maxlength: 300, default: "" },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true, collection: "template_departments" }
);

const designationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    key: { type: String, required: true, unique: true },
    short: { type: String, trim: true, maxlength: 12, default: "" },
    level: { type: Number, required: true, min: 1, max: 9 },
    // Standard departments (TemplateDepartment ids); empty = any department
    departments: [{ type: mongoose.Schema.Types.ObjectId, ref: "TemplateDepartment" }],
    suggestedRole: { type: String, enum: [...STAFF_ROLES, null], default: null },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true, collection: "template_designations" }
);

const TemplateDepartment = mongoose.model("TemplateDepartment", departmentSchema);
const TemplateDesignation = mongoose.model("TemplateDesignation", designationSchema);

// Fields a product-owner change can carry to organisations (order is each organisation's own)
const SYNCED = Object.freeze({
  department: Object.freeze(["name", "description", "isActive"]),
  designation: Object.freeze(["name", "short", "level", "suggestedRole", "departments", "isActive"])
});

module.exports = { TemplateDepartment, TemplateDesignation, SYNCED };
