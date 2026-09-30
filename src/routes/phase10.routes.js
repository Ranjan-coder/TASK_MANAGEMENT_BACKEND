const express = require("express");
const multer = require("multer");
const { z } = require("zod");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const { createLimiter } = require("../middlewares/rateLimiter.middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const payments = require("../services/payments.service");
const referrals = require("../services/referrals.service");
const { MAX_PDF_BYTES } = require("../services/media.service");
const { recordAuditLog } = require("../services/audit.service");

const ok = (res, data, message, status = 200) => res.status(status).json(new ApiResponse(status, data, message));
const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const paise = z.number().int().min(100, "At least ₹1").max(1_000_000_000_00, "Amount too large"); // up to ₹100 crore
const METHODS = ["upi", "bank_transfer", "cheque", "cash", "card"];
const text = (max) =>
  z
    .string()
    .transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .pipe(z.string().max(max));
const msParams = z.object({ projectId: id, milestoneId: id });
const paymentFields = {
  method: z.enum(METHODS),
  reference: text(60).pipe(z.string().regex(/^[\w\- /#.]*$/, "Use letters, numbers and - / only")).optional().default(""),
  amountPaise: paise,
  paidOn: z.coerce.date()
};

// ── Customers: their payments and referral code ──────────────────────────────
const paymentRoutes = express.Router();
paymentRoutes.use(authMiddleware, rbacMiddleware("customer", "admin", "superadmin"));
paymentRoutes.get("/mine", rbacMiddleware("customer"), asyncHandler(async (req, res) => ok(res, await payments.listMine(req.user._id))));
paymentRoutes.post(
  "/:projectId/milestones/:milestoneId/claim",
  rbacMiddleware("customer"),
  createLimiter({ windowMs: 60 * 60 * 1000, max: 20, message: "Too many requests." }),
  validate(z.object({ params: msParams, body: z.object({ ...paymentFields, note: text(300).optional().default("") }).strict() })),
  asyncHandler(async (req, res) => {
    const view = await payments.claimPayment({ conversationId: req.params.projectId, milestoneId: req.params.milestoneId, customer: req.user, ...req.body });
    await recordAuditLog({ req, action: "payment_claimed", targetType: "System", targetId: req.params.projectId, metadata: { milestone: req.params.milestoneId, amountPaise: req.body.amountPaise } });
    ok(res, view, "Thanks! We'll confirm your payment shortly.");
  })
);
paymentRoutes.get(
  "/:projectId/milestones/:milestoneId/receipt",
  validate(z.object({ params: msParams })),
  asyncHandler(async (req, res) => ok(res, await payments.getReceipt({ conversationId: req.params.projectId, milestoneId: req.params.milestoneId, viewer: req.user })))
);
paymentRoutes.get(
  "/:projectId/milestones/:milestoneId/invoice",
  validate(z.object({ params: msParams })),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    ok(res, await payments.invoiceLink({ conversationId: req.params.projectId, milestoneId: req.params.milestoneId, viewer: req.user }));
  })
);

const referralRoutes = express.Router();
referralRoutes.use(authMiddleware, rbacMiddleware("customer"));
referralRoutes.get("/mine", asyncHandler(async (req, res) => ok(res, await referrals.getMine(req.user._id))));

// ── Admin: payment schedules ─────────────────────────────────────────────────
const adminPaymentRoutes = express.Router();
// Admins do everything. Add-ons: "payments.view" reads; "payments.confirm" also
// confirms or rejects a customer's "I've paid" (no schedule edits, waivers or invoices).
adminPaymentRoutes.use(authMiddleware);
const payAdmin = rbacMiddleware("superadmin", "admin");
const payView = require("../middlewares/authorize.middleware")(["superadmin", "admin"], "payments.view", "payments.confirm");
const payConfirm = require("../middlewares/authorize.middleware")(["superadmin", "admin"], "payments.confirm");
adminPaymentRoutes.get(
  "/",
  payView,
  validate(z.object({ query: z.object({ filter: z.enum(["all", "verifying", "overdue"]).optional() }).strict() })),
  asyncHandler(async (req, res) => ok(res, await payments.adminList(req.query)))
);
adminPaymentRoutes.get("/:projectId", payView, validate(z.object({ params: z.object({ projectId: id }) })), asyncHandler(async (req, res) => ok(res, await payments.adminGet(req.params.projectId))));
adminPaymentRoutes.put(
  "/:projectId",
  payAdmin,
  validate(
    z.object({
      params: z.object({ projectId: id }),
      body: z
        .object({
          contractValuePaise: z.number().int().min(0).max(1_000_000_000_00),
          gstRatePct: z.number().min(0).max(28),
          notes: text(500).optional().default(""),
          milestones: z
            .array(z.object({ _id: id.optional(), title: text(80).pipe(z.string().min(2)), amountPaise: paise, dueDate: z.coerce.date().nullable().optional() }).strict())
            .max(20)
        })
        .strict()
    })
  ),
  asyncHandler(async (req, res) => {
    const out = await payments.saveSchedule({ conversationId: req.params.projectId, admin: req.user, ...req.body });
    await recordAuditLog({ req, action: "payment_schedule_saved", targetType: "System", targetId: req.params.projectId, metadata: { contractValuePaise: req.body.contractValuePaise, milestones: req.body.milestones.length } });
    ok(res, out, "Payment schedule saved");
  })
);
adminPaymentRoutes.post(
  "/:projectId/milestones/:milestoneId/confirm",
  payConfirm,
  validate(z.object({ params: msParams, body: z.object(paymentFields).strict() })),
  asyncHandler(async (req, res) => {
    const out = await payments.confirmPayment({
      conversationId: req.params.projectId,
      milestoneId: req.params.milestoneId,
      admin: req.user,
      ...req.body,
      claimedOnly: !["superadmin", "admin"].includes(req.user.role)
    });
    await recordAuditLog({ req, action: "payment_confirmed", targetType: "System", targetId: req.params.projectId, metadata: { milestone: req.params.milestoneId, amountPaise: req.body.amountPaise, method: req.body.method, receiptNo: out.receiptNo } });
    ok(res, out, `Payment confirmed — receipt ${out.receiptNo}`);
  })
);
adminPaymentRoutes.post(
  "/:projectId/milestones/:milestoneId/reject",
  payConfirm,
  validate(z.object({ params: msParams, body: z.object({ note: text(300).pipe(z.string().min(10, "Tell the customer what's wrong")) }).strict() })),
  asyncHandler(async (req, res) => {
    const out = await payments.rejectClaim({ conversationId: req.params.projectId, milestoneId: req.params.milestoneId, note: req.body.note });
    await recordAuditLog({ req, action: "payment_claim_rejected", targetType: "System", targetId: req.params.projectId, metadata: { milestone: req.params.milestoneId } });
    ok(res, out, "The customer has been told");
  })
);
adminPaymentRoutes.post(
  "/:projectId/milestones/:milestoneId/waive",
  payAdmin,
  validate(z.object({ params: msParams })),
  asyncHandler(async (req, res) => {
    const out = await payments.waiveMilestone({ conversationId: req.params.projectId, milestoneId: req.params.milestoneId });
    await recordAuditLog({ req, action: "payment_waived", targetType: "System", targetId: req.params.projectId, metadata: { milestone: req.params.milestoneId } });
    ok(res, out, "Payment waived");
  })
);
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 2 } });
adminPaymentRoutes.post(
  "/:projectId/milestones/:milestoneId/invoice",
  payAdmin,
  validate(z.object({ params: msParams })),
  pdfUpload.single("file"),
  asyncHandler(async (req, res) => {
    const ApiError = require("../utils/ApiError");
    if (!req.file) throw new ApiError(400, "Choose a PDF file");
    const out = await payments.attachInvoice({ conversationId: req.params.projectId, milestoneId: req.params.milestoneId, file: req.file });
    await recordAuditLog({ req, action: "invoice_uploaded", targetType: "System", targetId: req.params.projectId, metadata: { milestone: req.params.milestoneId } });
    ok(res, out, "Invoice uploaded — the customer has been told");
  })
);

// ── Admin: referrals ─────────────────────────────────────────────────────────
const adminReferralRoutes = express.Router();
adminReferralRoutes.use(authMiddleware, rbacMiddleware("superadmin", "admin"));
adminReferralRoutes.get(
  "/",
  validate(z.object({ query: z.object({ status: z.enum(["signed_up", "qualified", "rewarded", "rejected"]).optional() }).strict() })),
  asyncHandler(async (req, res) => ok(res, await referrals.adminList(req.query)))
);
adminReferralRoutes.patch(
  "/:id",
  validate(z.object({ params: z.object({ id }), body: z.object({ action: z.enum(["reward", "reject"]), note: text(500).optional().default("") }).strict() })),
  asyncHandler(async (req, res) => {
    const ref = await referrals.adminAct({ id: req.params.id, admin: req.user, ...req.body });
    await recordAuditLog({ req, action: `referral_${req.body.action === "reward" ? "rewarded" : "rejected"}`, targetType: "User", targetId: ref.referrer, metadata: { referral: ref._id } });
    ok(res, ref, req.body.action === "reward" ? "Reward confirmed — the customer has been told" : "Referral rejected");
  })
);

module.exports = { paymentRoutes, referralRoutes, adminPaymentRoutes, adminReferralRoutes };
