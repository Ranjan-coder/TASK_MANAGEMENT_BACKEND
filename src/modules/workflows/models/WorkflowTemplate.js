const mongoose = require("mongoose");

/**
 * The product owner's standard workflows (project-workflow-plan.md §5.2, W1, W7).
 * Platform-level and deliberately global: they hold no organisation's data, only
 * starting points. Every new organisation gets a copy of the one marked
 * `defaultForNewCompanies`; later versions are offered, never pushed.
 *
 * Versions are immutable documents (WorkflowTemplateVersion); the template only
 * points at the latest and holds the draft being edited.
 */
const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    // Exactly one template is the default (partial unique index below)
    defaultForNewCompanies: { type: Boolean, default: false },
    currentVersion: { type: Number, default: 0 },
    currentVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkflowTemplateVersion", default: null },
    draft: { type: mongoose.Schema.Types.Mixed, default: null }, // tree (engine/tree.js) or null
    draftRevision: { type: Number, default: 0 },
    archived: { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true, collection: "workflow_templates", minimize: false }
);
templateSchema.index({ defaultForNewCompanies: 1 }, { unique: true, partialFilterExpression: { defaultForNewCompanies: true } });

const templateVersionSchema = new mongoose.Schema(
  {
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkflowTemplate", required: true },
    version: { type: Number, required: true, min: 1 },
    tree: { type: mongoose.Schema.Types.Mixed, required: true },
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    publishedAt: { type: Date, default: Date.now }
  },
  { collection: "workflow_template_versions", minimize: false }
);
templateVersionSchema.index({ templateId: 1, version: 1 }, { unique: true });

const WorkflowTemplate = mongoose.model("WorkflowTemplate", templateSchema);
const WorkflowTemplateVersion = mongoose.model("WorkflowTemplateVersion", templateVersionSchema);

module.exports = { WorkflowTemplate, WorkflowTemplateVersion };
