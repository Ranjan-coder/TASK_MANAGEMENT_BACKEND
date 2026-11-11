const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");
const { STAFF_ROLES } = require("../config/roles");

/**
 * A job title with a seniority level (1 = Chairman / MD / CEO … 9 = Intern).
 * Managed by superadmins only. It never grants access: `suggestedRole` only
 * pre-fills the role when someone is created, and the creator confirms it.
 */
const designationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    key: { type: String, required: true },
    // Common abbreviation shown next to the name, e.g. "GM", "BM", "GTM"
    short: { type: String, trim: true, maxlength: 12, default: "" },
    level: { type: Number, required: true, min: 1, max: 9 },
    // Departments this title belongs to; empty = any department
    departments: [{ type: mongoose.Schema.Types.ObjectId, ref: "Department" }],
    suggestedRole: { type: String, enum: [...STAFF_ROLES, null], default: null },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    // Copy of a standard designation (OrgTemplate.js), or null for the organisation's own.
    // `overrides`: fields this organisation changed, which product-owner changes skip.
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "TemplateDesignation", default: null },
    overrides: { type: [{ type: String, enum: ["name", "short", "level", "suggestedRole", "departments", "isActive"] }], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

designationSchema.index({ isActive: 1, level: 1, sortOrder: 1 });
designationSchema.index({ orgId: 1, key: 1 }, { unique: true }); // names unique within an organisation
designationSchema.index({ templateId: 1 }, { partialFilterExpression: { templateId: { $type: "objectId" } } }); // product-owner changes reach every copy

designationSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("Designation", designationSchema);
