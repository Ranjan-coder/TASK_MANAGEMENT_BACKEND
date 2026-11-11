const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

const auditLogSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    action: {
      type: String,
      required: true,
      index: true
    },
    targetType: {
      type: String,
      enum: ["User", "Task", "Comment", "Attachment", "System", "Auth", "Department", "Designation", "Organisation", "OrgTemplate"],
      required: true
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    ipAddress: {
      type: String,
      default: "unknown"
    },
    userAgent: {
      type: String,
      default: "unknown"
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false } // Audit logs are immutable
  }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, createdAt: -1 });

auditLogSchema.plugin(tenantPlugin, { required: false }); // one organisation per document (module-access-plan.md)
const AuditLog = mongoose.model("AuditLog", auditLogSchema);
module.exports = AuditLog;
