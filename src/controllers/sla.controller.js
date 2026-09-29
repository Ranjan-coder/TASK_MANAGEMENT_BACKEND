const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const slaService = require("../services/sla.service");
const settingsService = require("../services/settings.service");
const { recordAuditLog } = require("../services/audit.service");

const listPending = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await slaService.listPendingForUser(req.user._id)));
});

const snooze = asyncHandler(async (req, res) => {
  const result = await slaService.snooze(req.params.id, req.user._id);
  res.status(200).json(new ApiResponse(200, result, "Reminder snoozed for 10 minutes"));
});

const getMetrics = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await slaService.getMetrics({ days: req.query.days })));
});

const getSettings = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await settingsService.getSettingsForAdmin()));
});

const PAYEE_FIELDS = ["upiId", "accountName", "accountNumber", "ifsc", "bankName", "companyName"];

const updateSettings = asyncHandler(async (req, res) => {
  // Where customers send money: only the super admin can change it (a stolen admin sign-in can't redirect payments)
  if (req.body.payments && req.user.role !== "superadmin") {
    const ApiError = require("../utils/ApiError");
    throw new ApiError(403, "Only the super admin can change payment details", [{ code: "SUPERADMIN_ONLY" }]);
  }
  const before = await settingsService.getSettingsForAdmin();
  const after = await settingsService.updateSettings(req.body, req.user._id);
  await recordAuditLog({
    req,
    action: "settings_updated",
    targetType: "System",
    targetId: after._id,
    metadata: {
      fields: Object.keys(req.body),
      ...(req.body.payments && {
        paymentsBefore: Object.fromEntries(PAYEE_FIELDS.map((k) => [k, before.payments?.[k] || ""])),
        paymentsAfter: Object.fromEntries(PAYEE_FIELDS.map((k) => [k, after.payments?.[k] || ""]))
      }),
      ...(req.body.escalationContacts && {
        escalationContactsBefore: (before.escalationContacts || []).map((u) => String(u._id || u)),
        escalationContactsAfter: (after.escalationContacts || []).map((u) => String(u._id || u))
      })
    }
  });
  const payeeChanged = req.body.payments && PAYEE_FIELDS.some((k) => (before.payments?.[k] || "") !== (after.payments?.[k] || ""));
  if (payeeChanged) {
    const User = require("../models/User");
    const { sendNotification } = require("../services/notification.service");
    const admins = await User.find({ role: { $in: ["admin", "superadmin"] }, status: "active" }).select("_id");
    for (const a of admins) {
      sendNotification({
        recipient: a._id,
        type: "security_alert",
        title: "Payment details changed",
        message: `${req.user.name} changed where customers pay (UPI ${after.payments?.upiId || "—"}, account ending ${String(after.payments?.accountNumber || "").slice(-4) || "—"}). If this wasn't expected, act now.`
      }).catch(() => {});
    }
  }
  res.status(200).json(new ApiResponse(200, after, "Settings saved"));
});

module.exports = { listPending, snooze, getMetrics, getSettings, updateSettings };
