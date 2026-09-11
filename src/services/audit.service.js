const AuditLog = require("../models/AuditLog");
const logger = require("../utils/logger");

const recordAuditLog = async ({ req, actorId, action, targetType, targetId, metadata = {} }) => {
  try {
    const ipAddress =
      req?.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req?.ip ||
      req?.socket?.remoteAddress ||
      "unknown";

    const userAgent = req?.headers["user-agent"] || "unknown";

    await AuditLog.create({
      actor: actorId || req?.user?._id || null,
      action,
      targetType,
      targetId: targetId || null,
      ipAddress,
      userAgent,
      metadata
    });
  } catch (error) {
    logger.error(`Audit logging failed: ${error.message}`);
  }
};

module.exports = { recordAuditLog };
