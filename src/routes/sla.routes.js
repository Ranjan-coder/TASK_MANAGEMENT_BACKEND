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

module.exports = { slaRoutes, adminSlaRoutes, settingsRoutes };
