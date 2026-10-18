const express = require("express");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const extras = require("../services/projectExtras.service");
const leads = require("../services/leads.service");
const { recordAuditLog } = require("../services/audit.service");
const { CONTENT_MANAGERS } = require("../controllers/content.controller");
const v = require("../validators/phase8.validator");

const ok = (res, data, message, status = 200) => res.status(status).json(new ApiResponse(status, data, message));
const STAFF = ["user", "admin", "superadmin"];

// ── /projects: status timeline (R1) ──────────────────────────────────────────
const projectRoutes = express.Router();
projectRoutes.use(authMiddleware);
projectRoutes.get("/mine", rbacMiddleware("customer"), asyncHandler(async (req, res) => ok(res, await extras.listMyProjects(req.user._id))));
projectRoutes.patch(
  "/:id/stage",
  rbacMiddleware(...STAFF),
  validate(v.stageSchema),
  asyncHandler(async (req, res) => {
    const view = await extras.setStage({ conversationId: req.params.id, actor: req.user, ...req.body });
    await recordAuditLog({ req, action: "project_stage_changed", targetType: "System", targetId: req.params.id, metadata: { stage: view.stage } });
    ok(res, view, "Project stage updated");
  })
);

// ── /projects/:id/flow — the company's workflow on one project (project-workflow-plan.md §7) ──
const flow = () => require("../modules/workflows/projectFlow.service");
const flowRoute = (method, path, schema, action, run) =>
  projectRoutes[method](
    path,
    rbacMiddleware(...STAFF),
    validate(schema),
    asyncHandler(async (req, res) => {
      const view = await run(req);
      await recordAuditLog({ req, action, targetType: "System", targetId: req.params.id, metadata: { ...req.body, ...(view.move && { move: view.move }) } });
      ok(res, view, "Updated");
    })
  );

// Read: chat members, admins, stage handlers, "view projects" holders (leadership included)
projectRoutes.get(
  "/:id/flow",
  rbacMiddleware(...STAFF, "leadership"),
  validate(v.idParams),
  asyncHandler(async (req, res) => ok(res, await flow().viewFor(req.params.id, req.user)))
);
flowRoute("patch", "/:id/step", v.stepMoveSchema, "project_step_moved", (req) => flow().move({ conversationId: req.params.id, actor: req.user, ...req.body }));
flowRoute("post", "/:id/flow/activate", v.stepPathSchema, "project_step_activated", (req) => flow().activate({ conversationId: req.params.id, actor: req.user, ...req.body }));
flowRoute("post", "/:id/flow/deactivate", v.stepPathSchema, "project_step_deactivated", (req) =>
  flow().deactivate({ conversationId: req.params.id, actor: req.user, path: req.body.path })
);
flowRoute("post", "/:id/flow/tick", v.tickSchema, "project_step_ticked", (req) => flow().tick({ conversationId: req.params.id, actor: req.user, ...req.body }));
flowRoute("post", "/:id/flow/extras", v.extraAddSchema, "project_extra_added", (req) => flow().addExtra({ conversationId: req.params.id, actor: req.user, ...req.body }));
flowRoute("patch", "/:id/flow/extras/:extraId", v.extraUpdateSchema, "project_extra_updated", (req) =>
  flow().updateExtra({ conversationId: req.params.id, actor: req.user, extraId: req.params.extraId, action: req.body.action })
);
flowRoute("post", "/:id/flow/checklist", v.checklistSchema, "project_checklist_ticked", (req) => flow().checklist({ conversationId: req.params.id, actor: req.user, ...req.body }));

// ── /chat approvals (R4) — mounted on the chat router's paths ────────────────
const approvalRoutes = express.Router();
approvalRoutes.use(authMiddleware);
const requireMember = asyncHandler(async (req, res, next) => {
  const Conversation = require("../models/Conversation");
  if (!(await Conversation.exists({ _id: req.params.id, "members.user": req.user._id }))) {
    const ApiError = require("../utils/ApiError");
    throw new ApiError(403, "You are not a member of this conversation");
  }
  next();
});
approvalRoutes.get("/conversations/:id/approvals", validate(v.idParams), requireMember, asyncHandler(async (req, res) => ok(res, await extras.listApprovals(req.params.id))));
approvalRoutes.post(
  "/conversations/:id/approvals",
  validate(v.requestApprovalSchema),
  requireMember,
  asyncHandler(async (req, res) => ok(res, await extras.requestApproval({ conversationId: req.params.id, actor: req.user, ...req.body }), "Approval requested", 201))
);
approvalRoutes.post(
  "/approvals/:id/decision",
  validate(v.decideApprovalSchema),
  asyncHandler(async (req, res) => ok(res, await extras.decideApproval({ approvalId: req.params.id, actor: req.user, ...req.body }), "Thanks — the designer has been told"))
);
approvalRoutes.post(
  "/approvals/:id/withdraw",
  validate(v.idParams),
  asyncHandler(async (req, res) => ok(res, await extras.withdrawApproval({ approvalId: req.params.id, actor: req.user }), "Request withdrawn"))
);

// ── /quick-replies (R5) — Bonito staff ───────────────────────────────────────
const quickReplyRoutes = express.Router();
quickReplyRoutes.use(authMiddleware, rbacMiddleware(...STAFF));
quickReplyRoutes.get("/", asyncHandler(async (req, res) => ok(res, await extras.listQuickReplies(req.user))));
quickReplyRoutes.post("/", validate(v.createQuickReplySchema), asyncHandler(async (req, res) => ok(res, await extras.createQuickReply(req.user, req.body), "Reply saved", 201)));
quickReplyRoutes.patch("/:id", validate(v.updateQuickReplySchema), asyncHandler(async (req, res) => ok(res, await extras.updateQuickReply(req.user, req.params.id, req.body), "Reply saved")));
quickReplyRoutes.delete(
  "/:id",
  validate(v.idParams),
  asyncHandler(async (req, res) => {
    await extras.deleteQuickReply(req.user, req.params.id);
    ok(res, null, "Reply deleted");
  })
);

// ── /admin/leads and /admin/testimonials — content managers ──────────────────
const adminLeadRoutes = express.Router();
// Content managers, or add-ons: "leads.view" reads, "leads.manage" also updates
adminLeadRoutes.use(authMiddleware);
adminLeadRoutes.get("/", require("../middlewares/authorize.middleware")(CONTENT_MANAGERS, "leads.view", "leads.manage"), validate(v.leadListSchema), asyncHandler(async (req, res) => ok(res, await leads.listLeads(req.query))));
adminLeadRoutes.patch(
  "/:id",
  require("../middlewares/authorize.middleware")(CONTENT_MANAGERS, "leads.manage"),
  validate(v.leadUpdateSchema),
  asyncHandler(async (req, res) => {
    const lead = await leads.updateLead(req.params.id, req.user, req.body);
    await recordAuditLog({ req, action: "lead_updated", targetType: "System", targetId: lead._id, metadata: { status: lead.status, note: Boolean(req.body.note) } });
    ok(res, lead, "Request updated");
  })
);

const adminTestimonialRoutes = express.Router();
adminTestimonialRoutes.use(authMiddleware, rbacMiddleware(...CONTENT_MANAGERS));
adminTestimonialRoutes.get("/", asyncHandler(async (req, res) => ok(res, await leads.listAllTestimonials())));
adminTestimonialRoutes.post(
  "/",
  validate(v.createTestimonialSchema),
  asyncHandler(async (req, res) => {
    const t = await leads.createTestimonial(req.user, req.body);
    await recordAuditLog({ req, action: "testimonial_created", targetType: "System", targetId: t._id, metadata: { published: t.isPublished } });
    ok(res, t, "Testimonial saved", 201);
  })
);
adminTestimonialRoutes.put(
  "/:id",
  validate(v.updateTestimonialSchema),
  asyncHandler(async (req, res) => {
    const t = await leads.updateTestimonial(req.params.id, req.body);
    await recordAuditLog({ req, action: "testimonial_updated", targetType: "System", targetId: t._id, metadata: { published: t.isPublished } });
    ok(res, t, "Testimonial saved");
  })
);
adminTestimonialRoutes.delete(
  "/:id",
  validate(v.idParams),
  asyncHandler(async (req, res) => {
    const t = await leads.deleteTestimonial(req.params.id);
    await recordAuditLog({ req, action: "testimonial_deleted", targetType: "System", targetId: t._id });
    ok(res, null, "Testimonial deleted");
  })
);

// Customers' Home: published testimonials
const testimonialRoutes = express.Router();
testimonialRoutes.use(authMiddleware);
testimonialRoutes.get("/", asyncHandler(async (req, res) => ok(res, await leads.listPublishedTestimonials())));

module.exports = { projectRoutes, approvalRoutes, quickReplyRoutes, adminLeadRoutes, adminTestimonialRoutes, testimonialRoutes };
