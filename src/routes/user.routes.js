const express = require("express");
const router = express.Router();

const userController = require("../controllers/user.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  createUserSchema,
  updateUserSchema,
  updateRoleSchema,
  updateStatusSchema
} = require("../validators/user.validator");

router.use(authMiddleware);

// List all users
router.get("/", rbacMiddleware("admin", "superadmin"), userController.getAllUsers);

// Create a new user (admin creates users; superadmin can create any role)
router.post(
  "/",
  rbacMiddleware("admin", "superadmin"),
  validate(createUserSchema),
  userController.createUser
);

// Update logged-in user profile (name, department, designation, avatarUrl)
router.patch("/profile", validate(updateUserSchema), userController.updateProfile);

// Get a specific user (self or admin/superadmin)
router.get("/:id", userController.getUserById);

// Update user info
router.patch(
  "/:id",
  rbacMiddleware("admin", "superadmin"),
  validate(updateUserSchema),
  userController.updateUser
);

// Change role (superadmin only)
router.patch(
  "/:id/role",
  rbacMiddleware("superadmin"),
  validate(updateRoleSchema),
  userController.updateUserRole
);

// Change status (admin/superadmin)
router.patch(
  "/:id/status",
  rbacMiddleware("admin", "superadmin"),
  validate(updateStatusSchema),
  userController.updateUserStatus
);

// Permanently delete (superadmin only)
router.delete("/:id", rbacMiddleware("superadmin"), userController.deleteUser);

module.exports = router;
