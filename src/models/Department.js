const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

/**
 * A team people belong to (Tech, Sales, Designer …). Managed by superadmins only.
 * Users keep a copy of the name (User.department) for fast reads; renames and
 * merges rewrite those copies in one bulk update (org.service.js).
 */
const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Normalised name (utils/orgKey) — unique, so near-duplicates are refused
    key: { type: String, required: true },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    head: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    // Copy of a standard department (OrgTemplate.js), or null for the organisation's own.
    // `overrides`: fields this organisation changed, which product-owner changes skip.
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "TemplateDepartment", default: null },
    overrides: { type: [{ type: String, enum: ["name", "description", "isActive"] }], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

departmentSchema.index({ isActive: 1, sortOrder: 1 });
departmentSchema.index({ orgId: 1, key: 1 }, { unique: true }); // names unique within an organisation
departmentSchema.index({ templateId: 1 }, { partialFilterExpression: { templateId: { $type: "objectId" } } }); // product-owner changes reach every copy

departmentSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("Department", departmentSchema);
