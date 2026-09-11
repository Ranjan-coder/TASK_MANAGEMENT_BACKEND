const express = require("express");
const router = express.Router();

const taskController = require("../controllers/task.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const { verifyTaskAccess } = require("../middlewares/verifyAccess.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  createTaskSchema,
  updateTaskSchema,
  updateStatusSchema
} = require("../validators/task.validator");

router.use(authMiddleware);

// List tasks (scoped by role)
router.get("/", taskController.getTasks);

// Create task (admin/superadmin)
router.post(
  "/",
  rbacMiddleware("admin", "superadmin"),
  validate(createTaskSchema),
  taskController.createTask
);

// Get task by ID (all authorized)
router.get("/:id", verifyTaskAccess("view"), taskController.getTaskById);

// Get task activity timeline
router.get("/:id/activity", verifyTaskAccess("view"), taskController.getTaskActivity);

// Edit task metadata (admin/superadmin + creator)
router.patch(
  "/:id",
  verifyTaskAccess("edit"),
  validate(updateTaskSchema),
  taskController.updateTask
);

// Update task status (assignee, admin, superadmin)
router.patch(
  "/:id/status",
  verifyTaskAccess("status_update"),
  validate(updateStatusSchema),
  taskController.updateTaskStatus
);

// Reassign task (admin/superadmin)
router.patch(
  "/:id/reassign",
  rbacMiddleware("admin", "superadmin"),
  verifyTaskAccess("edit"),
  taskController.reassignTask
);

// Archive/Delete task
router.delete("/:id", verifyTaskAccess("delete"), taskController.deleteTask);

module.exports = router;
