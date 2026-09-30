const express = require("express");
const router = express.Router();

const controller = require("../controllers/project.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const v = require("../validators/project.validator");
const authorize = require("../middlewares/authorize.middleware");
const ADMIN = ["superadmin", "admin"];


// Only Bonito admins set up project chats and their teams; "projects.view" can look
router.use(authMiddleware);
const view = authorize(ADMIN, "projects.view");
const adminOnly = rbacMiddleware(...ADMIN);

router.get("/", view, validate(v.listProjectsSchema), controller.listProjects);
router.post("/", adminOnly, validate(v.createProjectSchema), controller.createProject);
router.get("/:id", view, validate(v.projectIdSchema), controller.getProject);
router.put("/:id", adminOnly, validate(v.updateProjectSchema), controller.updateProject);

module.exports = router;
