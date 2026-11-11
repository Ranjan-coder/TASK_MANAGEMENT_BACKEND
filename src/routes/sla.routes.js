const express = require("express");
const controller = require("../controllers/sla.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const v = require("../validators/settings.validator");

// Designers' reply reminders (Bonito delivery staff only)
const slaRoutes = express.Router();
slaRoutes.use(authMiddleware, rbacMiddleware("superadmin", "admin", "user"));
slaRoutes.get("/pending", controller.listPending);
slaRoutes.post("/:id/snooze", validate(v.slaIdSchema), controller.snooze);

// Admin: response metrics and reply-timer settings
const adminSlaRoutes = express.Router();
adminSlaRoutes.use(authMiddleware);
adminSlaRoutes.get("/metrics", require("../middlewares/authorize.middleware")(["superadmin", "admin"], "performance.view"), validate(v.metricsSchema), controller.getMetrics);

const settingsRoutes = express.Router();
settingsRoutes.use(authMiddleware, rbacMiddleware("superadmin", "admin"));
settingsRoutes.get("/", controller.getSettings);
settingsRoutes.put("/", validate(v.updateSettingsSchema), controller.updateSettings);

// Company-wide project contacts (project-contacts-plan.md P2): a project's own contacts replace these
const contactsV = require("../validators/phase8.validator");
const projectContacts = () => require("../services/projectContacts.service");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { recordAuditLog } = require("../services/audit.service");
settingsRoutes.get("/project-contacts", asyncHandler(async (req, res) => res.json(new ApiResponse(200, await projectContacts().getCompanyContacts()))));
settingsRoutes.put(
  "/project-contacts",
  validate(contactsV.companyContactsSchema),
  asyncHandler(async (req, res) => {
    const view = await projectContacts().setCompanyContacts({ actor: req.user, ...req.body });
    await recordAuditLog({
      req,
      action: "company_contacts_updated",
      targetType: "System",
      metadata: { contacts: req.body.contacts.map((c) => ({ topic: c.topic, label: c.label, user: c.user })) }
    });
    res.json(new ApiResponse(200, view, "Contacts saved"));
  })
);
settingsRoutes.get(
  "/project-contacts/candidates",
  validate(contactsV.companyCandidatesSchema),
  asyncHandler(async (req, res) => res.json(new ApiResponse(200, await projectContacts().candidates(req.query.search))))
);

module.exports = { slaRoutes, adminSlaRoutes, settingsRoutes };
