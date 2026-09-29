const express = require("express");
const controller = require("../controllers/moderation.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const { createLimiter } = require("../middlewares/rateLimiter.middleware");
const v = require("../validators/moderation.validator");

// Any signed-in user: download the word list, count a prevented message
const moderationRoutes = express.Router();
moderationRoutes.use(authMiddleware);
moderationRoutes.get("/lexicon", controller.getLexicon);
moderationRoutes.post(
  "/prevented",
  createLimiter({ windowMs: 60 * 60 * 1000, max: 60, message: "Too many requests." }),
  validate(v.preventedSchema),
  controller.recordPrevented
);

// Admins: alerts and the word list
const adminModerationRoutes = express.Router();
adminModerationRoutes.use(authMiddleware, rbacMiddleware("superadmin", "admin"));
adminModerationRoutes.get("/incidents", validate(v.listIncidentsSchema), controller.listIncidents);
adminModerationRoutes.get("/incidents/:id", validate(v.termIdSchema), controller.getIncident);
adminModerationRoutes.patch("/incidents/:id", validate(v.incidentActionSchema), controller.actOnIncident);
adminModerationRoutes.get("/lexicon", controller.listTerms);
adminModerationRoutes.post("/lexicon", validate(v.addTermSchema), controller.addTerm);
adminModerationRoutes.patch("/lexicon/:id", validate(v.updateTermSchema), controller.updateTerm);
adminModerationRoutes.delete("/lexicon/:id", validate(v.termIdSchema), controller.deleteTerm);

module.exports = { moderationRoutes, adminModerationRoutes };
