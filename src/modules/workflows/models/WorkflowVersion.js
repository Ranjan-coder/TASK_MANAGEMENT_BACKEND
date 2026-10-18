const mongoose = require("mongoose");
const tenantPlugin = require("../../../models/plugins/tenant.plugin");

/**
 * A published version of an organisation's workflow. Never changed after it is
 * written (W6): projects point at a version, so editing the workflow can't break
 * a project that is part-way through. Compiled forms are cached for good
 * (versionCache.js) because the tree can't change underneath them.
 */
const versionSchema = new mongoose.Schema(
  {
    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow", required: true },
    version: { type: Number, required: true, min: 1 },
    tree: { type: mongoose.Schema.Types.Mixed, required: true },
    // How it came about: the starting copy, an edit, or taking a standard update
    source: { type: String, enum: ["standard", "edit", "update"], default: "edit" },
    summary: { type: mongoose.Schema.Types.Mixed, default: null }, // diff against the previous version
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    publishedAt: { type: Date, default: Date.now }
  },
  { minimize: false }
);
versionSchema.plugin(tenantPlugin);
versionSchema.index({ orgId: 1, workflowId: 1, version: 1 }, { unique: true });

// Published versions are immutable: refuse updates through Mongoose
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"]) {
  versionSchema.pre(op, function () {
    throw new Error("Workflow versions can't be changed once published");
  });
}

module.exports = mongoose.model("WorkflowVersion", versionSchema);
