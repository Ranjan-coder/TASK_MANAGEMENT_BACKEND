const express = require("express");
const { z } = require("zod");
const authMiddleware = require("../../middlewares/auth.middleware");
const rbacMiddleware = require("../../middlewares/rbac.middleware");
const validate = require("../../middlewares/validate.middleware");
const asyncHandler = require("../../utils/asyncHandler");
const ApiResponse = require("../../utils/ApiResponse");
const { recordAuditLog } = require("../../services/audit.service");
const workflows = require("./workflow.service");
const editor = require("./editor.service");
const versionCache = require("./versionCache");

/**
 * /api/v1/workflow — the company's workflow (project-workflow-plan.md §8).
 * Reading: staff. Editing: admins everywhere, stage handlers on their own stages
 * (checked in editor.service on the actual changes, not here).
 */
const router = express.Router();
const ok = (res, data, message = "OK") => res.status(200).json(new ApiResponse(200, data, message));
const STAFF = ["user", "admin", "superadmin", "marketing", "leadership"];
const EDITORS = ["user", "admin", "superadmin"]; // handlers are staff ("user") or admins

const stepKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}(\/[a-z][a-z0-9_]{1,39})?$/);
const revision = z.number().int().min(0);
// The tree's shape is checked in full by engine/tree.js (limits, keys, text); here only its size
const treeSchema = z.object({ stages: z.array(z.record(z.any())).min(1).max(20) }).passthrough();

router.use(authMiddleware, rbacMiddleware(...STAFF));

/** Current version: stages and sub-stages as staff see them (no project). */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { workflow, currentVersionId } = await workflows.current();
    const c = await versionCache.get(currentVersionId);
    ok(res, {
      name: workflow.name,
      version: c.version,
      versionId: c.versionId,
      stages: c.stages.map((s) => ({
        key: s.key,
        name: s.name,
        customerName: s.customerName,
        description: s.description,
        departmentId: s.departmentId,
        handlers: s.handlers,
        subOrder: s.subOrder,
        durationDays: s.durationDays,
        gates: s.gates,
        paymentDueDays: s.paymentDueDays,
        entryMessage: s.entryMessage,
        subStages: s.subs.map((x) => ({ key: x.key, path: x.path, name: x.name, customerName: x.customerName, optional: x.optional, showToCustomer: x.showToCustomer, durationDays: x.durationDays }))
      })),
      steps: c.steps.map((s) => ({ key: s.key, stageKey: c.stages[s.stageIdx].key, optional: s.optional }))
    });
  })
);

// ── Editor ────────────────────────────────────────────────────────────────────

router.get("/editor", rbacMiddleware(...EDITORS), asyncHandler(async (req, res) => ok(res, await editor.editorState(req.user))));

router.put(
  "/draft",
  rbacMiddleware(...EDITORS),
  validate(z.object({ body: z.object({ tree: treeSchema, revision }).strict() })),
  asyncHandler(async (req, res) => {
    const out = await editor.saveDraft(req.user, req.body);
    ok(res, out, "Draft saved");
  })
);

router.post(
  "/draft/discard",
  rbacMiddleware(...EDITORS),
  validate(z.object({ body: z.object({ revision }).strict() })),
  asyncHandler(async (req, res) => {
    const out = await editor.discardDraft(req.user, req.body);
    await recordAuditLog({ req, action: "workflow_draft_discarded", targetType: "System", metadata: {} });
    ok(res, out, "Draft discarded");
  })
);

router.post(
  "/publish",
  rbacMiddleware(...EDITORS),
  validate(z.object({ body: z.object({ revision }).strict() })),
  asyncHandler(async (req, res) => {
    const out = await editor.publish(req.user, req.body);
    await recordAuditLog({
      req,
      action: "workflow_published",
      targetType: "System",
      metadata: { version: out.version, added: out.summary.added.length, removed: out.summary.removed.length, renamed: out.summary.renamed.length, changed: out.summary.changed.length, stages: out.summary.touchedStages }
    });
    ok(res, out, `Version ${out.version} published`);
  })
);

router.get("/versions", rbacMiddleware(...EDITORS), asyncHandler(async (req, res) => ok(res, await editor.versions())));
router.get(
  "/versions/:version",
  rbacMiddleware(...EDITORS),
  validate(z.object({ params: z.object({ version: z.coerce.number().int().min(1) }) })),
  asyncHandler(async (req, res) => ok(res, await editor.versionTree(req.params.version)))
);

// ── Time-in-stage report (E2): admins and "view performance" holders (e.g. leadership) ──
router.get(
  "/report",
  require("../../middlewares/authorize.middleware")(["admin", "superadmin"], "performance.view"),
  validate(z.object({ query: z.object({ days: z.coerce.number().int().refine((d) => [30, 90, 180, 365].includes(d), "Use 30, 90, 180 or 365").optional().default(180) }).strict() })),
  asyncHandler(async (req, res) => ok(res, await require("./report.service").stageReport({ days: req.query.days })))
);

// ── Standard workflow updates (W7: offered, admins decide) ────────────────────

router.post(
  "/offer/apply",
  rbacMiddleware("admin", "superadmin"),
  asyncHandler(async (req, res) => {
    const out = await editor.applyOffer(req.user);
    await recordAuditLog({ req, action: "workflow_update_merged", targetType: "System", metadata: { conflicts: out.conflicts.length, added: out.changes.added.length, removed: out.changes.removed.length } });
    ok(res, out, out.conflicts.length ? `Merged into the draft with ${out.conflicts.length} item(s) to review` : "Merged into the draft. Review and publish.");
  })
);
router.post(
  "/offer/dismiss",
  rbacMiddleware("admin", "superadmin"),
  asyncHandler(async (req, res) => {
    const out = await editor.dismissOffer(req.user);
    await recordAuditLog({ req, action: "workflow_update_dismissed", targetType: "System", metadata: out });
    ok(res, out, "Update dismissed");
  })
);

// ── Moving running projects (W6) ──────────────────────────────────────────────

router.get(
  "/migrate/:fromVersion",
  rbacMiddleware(...EDITORS),
  validate(z.object({ params: z.object({ fromVersion: z.coerce.number().int().min(1) }) })),
  asyncHandler(async (req, res) => ok(res, await editor.migrationPlan(req.params.fromVersion)))
);
router.post(
  "/migrate",
  rbacMiddleware(...EDITORS),
  validate(z.object({ body: z.object({ fromVersion: z.number().int().min(1), mapping: z.record(stepKey, stepKey).optional().default({}) }).strict() })),
  asyncHandler(async (req, res) => {
    const out = await editor.migrate(req.user, req.body);
    await recordAuditLog({ req, action: "workflow_projects_moved", targetType: "System", metadata: { ...req.body, ...out } });
    ok(res, out, `${out.moved} project(s) moved to version ${out.toVersion}`);
  })
);

module.exports = router;
