const express = require("express");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const { recordAuditLog } = require("../services/audit.service");
const org = require("../services/org.service");
const v = require("../validators/org.validator");
const { STAFF_ROLES, ADMIN_ROLES, ROLES } = require("../config/roles");
const { PERMISSIONS, ROLE_IMPLIED, GRANTABLE_ROLES } = require("../config/permissions");
const modules = require("../config/modules");
const access = require("../services/moduleAccess.service");

/**
 * /api/v1/org — departments, designations, org chart.
 * Read: any staff member. Create / change / merge / reorder / delete: superadmin only (D3).
 */
const router = express.Router();
const ok = (res, data, message = "OK", status = 200) => res.status(status).json(new ApiResponse(status, data, message));
const yes = (x) => x === "1" || x === "true";
const superadminOnly = rbacMiddleware(ROLES.SUPERADMIN);

router.use(authMiddleware, rbacMiddleware(...STAFF_ROLES));

// Inactive items and user counts are for the people who manage the lists
const listOptions = (req) => ({
  includeInactive: yes(req.query.includeInactive) && req.user.role === ROLES.SUPERADMIN,
  withCounts: yes(req.query.counts) && ADMIN_ROLES.includes(req.user.role)
});

router.get("/departments", validate(v.listSchema), asyncHandler(async (req, res) => ok(res, await org.listDepartments(listOptions(req)))));
router.get(
  "/designations",
  validate(v.listSchema),
  asyncHandler(async (req, res) => {
    const [items, minLevel] = await Promise.all([org.listDesignations(listOptions(req)), org.minAssignableLevel(req.user)]);
    // Lets the user form grey out titles this person isn't allowed to give
    ok(res, { items, minAssignableLevel: ADMIN_ROLES.includes(req.user.role) ? minLevel : null });
  })
);

// Permission catalog for the user screen (labels, and what each role already includes)
router.get("/permissions", rbacMiddleware(...ADMIN_ROLES), (req, res) =>
  ok(res, {
    permissions: Object.entries(PERMISSIONS).map(([key, p]) => ({ key, label: p.label, module: p.module })),
    implied: ROLE_IMPLIED,
    grantableRoles: GRANTABLE_ROLES
  })
);

// ── Modules (module-access-plan.md, Phase 4): superadmin gives modules to people ──

// The organisation's modules with seats in use, for the access screens
router.get(
  "/modules",
  superadminOnly,
  asyncHandler(async (req, res) => {
    const [usage, limits] = await Promise.all([access.seatUsage(), require("../services/organisation.service").getSeatLimits(req.user.orgId)]);
    const rows = modules.MODULES.filter((m) => req.orgModules & modules.BIT[m.key]).map((m) => ({
      key: m.key,
      label: m.label,
      description: m.description,
      core: Boolean(m.core),
      requiresAll: modules.fromMask(modules.REQUIRES_MASK[m.key]),
      neededBy: modules.fromMask(modules.DEPENDENTS_MASK[m.key] & req.orgModules),
      defaultOn: Boolean(m.defaultOn),
      // A setting of the whole organisation (e.g. branding): everyone has it
      orgWide: Boolean(m.orgWide),
      // Seats only for modules given person by person
      seatLimit: m.core || m.defaultOn || m.orgWide ? null : limits.get(m.key) ?? null,
      seatsUsed: m.core || m.defaultOn || m.orgWide ? null : usage.get(m.key) || 0,
      // Staff-only modules the superadmin may open to customers
      customerOptIn: Boolean(m.customerOptIn),
      customersEnabled: Boolean(req.orgCustomerModules & modules.BIT[m.key])
    }));
    ok(res, rows);
  })
);

// Open a staff-only module to this organisation's customers, or close it again.
// Superadmin only. Customers' data is kept when closed (lazy cascade).
router.patch(
  "/modules/:key/customers",
  superadminOnly,
  validate(v.moduleCustomersSchema),
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    if (!modules.CUSTOMER_OPT_IN_KEYS.includes(key)) throw new ApiError(400, "This module can't be opened to customers");
    if (!(req.orgModules & modules.BIT[key])) throw new ApiError(400, "Your organisation doesn't have this module", [{ code: "MODULE_NOT_IN_ORG" }]);
    const Organisation = require("../models/Organisation");
    const op = req.body.enabled ? { $addToSet: { customerModules: key } } : { $pull: { customerModules: key } };
    await Organisation.updateOne({ _id: req.user.orgId }, { ...op, $inc: { entitlementVersion: 1 } });
    require("../services/organisation.service").invalidate(req.user.orgId);
    await recordAuditLog({ req, action: req.body.enabled ? "module_opened_to_customers" : "module_closed_to_customers", targetType: "System", metadata: { module: key } });
    ok(res, { key, customersEnabled: req.body.enabled }, req.body.enabled ? "Customers can now use it" : "Customers can no longer use it");
  })
);

// One module to many people (or taken away from them) in one go
router.post(
  "/modules/:key/members",
  superadminOnly,
  validate(v.moduleMembersSchema),
  asyncHandler(async (req, res) => {
    const result = await access.bulkSetModule(req.params.key, req.body, req.orgModules);
    for (const id of result.changed) require("../sockets").disconnectSessions(id).catch(() => {});
    await recordAuditLog({
      req,
      action: "module_members_changed",
      targetType: "System",
      metadata: { module: req.params.key, added: req.body.add?.length || 0, removed: req.body.remove?.length || 0, changed: result.changed.length }
    });
    ok(res, { changed: result.changed.length, skipped: result.skipped }, "Module access updated");
  })
);

router.get("/chart", asyncHandler(async (req, res) => ok(res, await org.getChart())));
router.get(
  "/team",
  validate(v.teamSchema),
  asyncHandler(async (req, res) => {
    // Your own team; admins may look at anyone's
    const userId = req.query.userId || String(req.user._id);
    if (userId !== String(req.user._id) && !ADMIN_ROLES.includes(req.user.role)) throw new ApiError(403, "You can only see your own team");
    ok(res, await org.getTeam(userId));
  })
);

// ── Superadmin: manage the lists ──────────────────────────────────────────────

const audit = (req, action, targetType, targetId, metadata) => recordAuditLog({ req, action, targetType, targetId, metadata });
const snapshotOf = (x) =>
  x && { name: x.name, isActive: x.isActive, ...(x.level !== undefined && { level: x.level, short: x.short, suggestedRole: x.suggestedRole }) };

for (const kind of ["department", "designation"]) {
  const base = `/${kind}s`;
  const Target = kind === "department" ? "Department" : "Designation";
  const createSchema = kind === "department" ? v.createDepartmentSchema : v.createDesignationSchema;
  const updateSchema = kind === "department" ? v.updateDepartmentSchema : v.updateDesignationSchema;
  const create = kind === "department" ? org.createDepartment : org.createDesignation;

  // Registered before the "/:id" routes so "order" isn't read as an id
  router.put(
    `${base}/order`,
    superadminOnly,
    validate(v.reorderSchema),
    asyncHandler(async (req, res) => {
      await org.reorder(kind, req.body.ids);
      await audit(req, `${kind}s_reordered`, Target, null, { count: req.body.ids.length });
      ok(res, null, "Order saved");
    })
  );

  router.post(
    base,
    superadminOnly,
    validate(createSchema),
    asyncHandler(async (req, res) => {
      const item = await create(req.user, req.body);
      await audit(req, `${kind}_created`, Target, item._id, { after: snapshotOf(item) });
      ok(res, item, `${Target} created`, 201);
    })
  );

  router.patch(
    `${base}/:id`,
    superadminOnly,
    validate(updateSchema),
    asyncHandler(async (req, res) => {
      const { before, after, usersRenamed } = await org.updateItem(kind, req.user, req.params.id, req.body);
      await audit(req, `${kind}_updated`, Target, after._id, { before: snapshotOf(before), after: snapshotOf(after), usersRenamed });
      ok(res, after, `${Target} updated`);
    })
  );

  // Take the product owner's standard values again (drops this organisation's own changes)
  router.post(
    `${base}/:id/reset`,
    superadminOnly,
    validate(v.idOnlySchema),
    asyncHandler(async (req, res) => {
      const { before, after, usersRenamed } = await org.resetItem(kind, req.user, req.params.id);
      await audit(req, `${kind}_reset_to_standard`, Target, after._id, { before: snapshotOf(before), after: snapshotOf(after), usersRenamed });
      ok(res, after, "Reset to the standard version");
    })
  );

  router.post(
    `${base}/:id/merge`,
    superadminOnly,
    validate(v.mergeSchema),
    asyncHandler(async (req, res) => {
      const { from, into, usersMoved } = await org.mergeItem(kind, req.user, req.params.id, req.body.into);
      await audit(req, `${kind}_merged`, Target, into._id, { from: from.name, into: into.name, usersMoved });
      ok(res, { usersMoved }, `Merged "${from.name}" into "${into.name}"`);
    })
  );

  router.delete(
    `${base}/:id`,
    superadminOnly,
    validate(v.idOnlySchema),
    asyncHandler(async (req, res) => {
      const item = await org.deleteItem(kind, req.params.id);
      await audit(req, `${kind}_deleted`, Target, item._id, { before: snapshotOf(item) });
      ok(res, null, `${Target} deleted`);
    })
  );
}

module.exports = router;
