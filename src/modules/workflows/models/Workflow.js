const mongoose = require("mongoose");
const tenantPlugin = require("../../../models/plugins/tenant.plugin");

/**
 * An organisation's project workflow (project-workflow-plan.md §5.2). Exactly one
 * per organisation (W2; unique on orgId + scope, room for other kinds later).
 *
 * The published versions are immutable WorkflowVersion documents; this document
 * points at the current one and holds the draft. `draftRevision` makes draft saves
 * and publishing conditional, so two editors can't overwrite each other.
 */
const workflowSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ["projects"], default: "projects" },
    name: { type: String, trim: true, maxlength: 80, default: "Project workflow" },
    currentVersion: { type: Number, default: 0 },
    currentVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkflowVersion", default: null },
    draft: { type: mongoose.Schema.Types.Mixed, default: null }, // tree, or null when there's no draft
    draftRevision: { type: Number, default: 0 },
    draftUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    draftUpdatedAt: { type: Date, default: null },
    // Which standard workflow (and version) this one started from or last took an update from (W7)
    basedOn: {
      templateId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkflowTemplate", default: null },
      version: { type: Number, default: null },
      tree: { type: mongoose.Schema.Types.Mixed, default: null } // the standard tree at that point (three-way merge base)
    },
    // A newer standard version the organisation chose not to take (hides the offer)
    dismissedTemplateVersion: { type: Number, default: null },
    // Set when an update was merged into the draft: becomes `basedOn` only when that
    // draft is published (discarding the draft keeps the offer)
    pendingBase: {
      templateId: { type: mongoose.Schema.Types.ObjectId, default: null },
      version: { type: Number, default: null },
      tree: { type: mongoose.Schema.Types.Mixed, default: null }
    }
  },
  { timestamps: true, minimize: false }
);
workflowSchema.plugin(tenantPlugin);
workflowSchema.index({ orgId: 1, scope: 1 }, { unique: true });

module.exports = mongoose.model("Workflow", workflowSchema);
