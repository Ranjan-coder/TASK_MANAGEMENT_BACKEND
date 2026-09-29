const express = require("express");
const router = express.Router();

const controller = require("../controllers/project.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const v = require("../validators/project.validator");

// Only Bonito admins set up project chats and their teams
router.use(authMiddleware, rbacMiddleware("superadmin", "admin"));

router.get("/", validate(v.listProjectsSchema), controller.listProjects);
router.post("/", validate(v.createProjectSchema), controller.createProject);
router.get("/:id", validate(v.projectIdSchema), controller.getProject);
router.put("/:id", validate(v.updateProjectSchema), controller.updateProject);

module.exports = router;
