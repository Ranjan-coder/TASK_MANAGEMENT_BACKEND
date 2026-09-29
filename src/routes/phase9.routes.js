const express = require("express");
const { z } = require("zod");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const { createLimiter } = require("../middlewares/rateLimiter.middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const push = require("../services/push.service");
const privacy = require("../services/privacy.service");
const { recordAuditLog } = require("../services/audit.service");

const ok = (res, data, message, status = 200) => res.status(status).json(new ApiResponse(status, data, message));
const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const b64url = (max) => z.string().max(max).regex(/^[A-Za-z0-9_-]+=*$/, "Invalid key");

// ── /push: register this device for notifications (R7) ───────────────────────
const pushRoutes = express.Router();
pushRoutes.use(authMiddleware);
pushRoutes.get("/vapid-key", (req, res) => ok(res, { publicKey: push.configured ? push.publicKey : null }));
const subscriptionSchema = z.object({
  body: z
    .object({
      endpoint: z.string().url().max(1000),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({ p256dh: b64url(200), auth: b64url(100) }).strict()
    })
    .strict()
});
pushRoutes.post(
  "/subscribe",
  createLimiter({ windowMs: 60 * 60 * 1000, max: 30, message: "Too many requests." }),
  validate(subscriptionSchema),
  asyncHandler(async (req, res) => {
    await push.subscribe({ user: req.user, sessionId: req.sessionId, subscription: req.body, userAgent: req.headers["user-agent"] });
    ok(res, { subscribed: true }, "Notifications turned on for this device", 201);
  })
);
pushRoutes.delete(
  "/subscribe",
  validate(z.object({ body: z.object({ endpoint: z.string().url().max(1000) }).strict() })),
  asyncHandler(async (req, res) => {
    await push.unsubscribe(req.user._id, req.body.endpoint);
    ok(res, { subscribed: false }, "Notifications turned off for this device");
  })
);

// ── /privacy: your data (DPDP Act, R8) ───────────────────────────────────────
const privacyRoutes = express.Router();
privacyRoutes.use(authMiddleware);
privacyRoutes.get(
  "/export",
  createLimiter({ windowMs: 60 * 60 * 1000, max: 5, message: "You can download your data a few times an hour. Please try again later." }),
  asyncHandler(async (req, res) => {
    const data = await privacy.exportMyData(req.user._id);
    await recordAuditLog({ req, action: "data_exported", targetType: "User", targetId: req.user._id });
    res.set("Cache-Control", "no-store");
    ok(res, data);
  })
);
privacyRoutes.get("/deletion", asyncHandler(async (req, res) => ok(res, await privacy.myDeletionStatus(req.user._id))));
privacyRoutes.post(
  "/deletion",
  createLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 5, message: "Please try again tomorrow." }),
  validate(z.object({ body: z.object({ reason: z.string().trim().max(1000).optional().default("") }).strict() })),
  asyncHandler(async (req, res) => {
    const r = await privacy.requestDeletion(req.user, req.body.reason);
    await recordAuditLog({ req, action: "deletion_requested", targetType: "User", targetId: req.user._id });
    const { getEscalationRecipients } = require("../services/settings.service");
    const { sendNotification } = require("../services/notification.service");
    for (const a of await getEscalationRecipients()) {
      sendNotification({ recipient: a._id, type: "security_alert", title: "Account deletion request", message: "A customer asked for their account and data to be deleted. Review it in Admin → Privacy." }).catch(() => {});
    }
    ok(res, r, "Request received. We'll process it within 30 days and let you know.", 201);
  })
);
privacyRoutes.delete(
  "/deletion",
  asyncHandler(async (req, res) => {
    await privacy.cancelDeletion(req.user._id);
    await recordAuditLog({ req, action: "deletion_cancelled", targetType: "User", targetId: req.user._id });
    ok(res, null, "Deletion request cancelled");
  })
);

// ── /admin/privacy: handle deletion requests ─────────────────────────────────
const adminPrivacyRoutes = express.Router();
adminPrivacyRoutes.use(authMiddleware, rbacMiddleware("superadmin", "admin"));
adminPrivacyRoutes.get(
  "/deletion-requests",
  validate(z.object({ query: z.object({ status: z.enum(["pending", "cancelled", "completed", "rejected"]).optional() }).strict() })),
  asyncHandler(async (req, res) => ok(res, await privacy.listDeletionRequests(req.query)))
);
adminPrivacyRoutes.patch(
  "/deletion-requests/:id",
  validate(
    z.object({
      params: z.object({ id }),
      body: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(1000).optional().default("") }).strict()
    })
  ),
  asyncHandler(async (req, res) => {
    const r = await privacy.handleDeletionRequest({ requestId: req.params.id, admin: req.user, ...req.body });
    await recordAuditLog({ req, action: `deletion_${req.body.decision}d`, targetType: "User", targetId: r.user, metadata: { requestId: r._id, summary: r.summary } });
    ok(res, r, req.body.decision === "approve" ? "Customer data deleted" : "Request rejected — the customer has been told why");
  })
);

module.exports = { pushRoutes, privacyRoutes, adminPrivacyRoutes };
