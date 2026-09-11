const express = require("express");
const router = express.Router();

const authController = require("../controllers/auth.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const validate = require("../middlewares/validate.middleware");
const { authLimiter } = require("../middlewares/rateLimiter.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const {
  registerSchema,
  loginSchema,
  verify2FASchema,
  forgotPasswordSchema,
  resetPasswordSchema
} = require("../validators/auth.validator");

// Public Auth Routes
router.post("/register", validate(registerSchema), authController.register);
router.post("/login", authLimiter, validate(loginSchema), authController.login);
router.post("/2fa/verify", authLimiter, validate(verify2FASchema), authController.verify2FA);
router.post("/refresh", authController.refreshToken);
router.post("/forgot-password", authLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post("/reset-password/:token", authLimiter, validate(resetPasswordSchema), authController.resetPassword);

// Authenticated Routes
router.post("/2fa/setup", authMiddleware, authController.setup2FA);
router.post("/2fa/enable", authMiddleware, authController.enable2FA);
router.post("/2fa/disable", authMiddleware, authController.disable2FA);
router.post("/logout", authMiddleware, authController.logout);
router.get("/me", authMiddleware, authController.getMe);

// Session Management
router.get("/sessions", authMiddleware, authController.getSessions);
router.post("/sessions/revoke-all", authMiddleware, authController.revokeAllSessions);
router.delete("/sessions/:id", authMiddleware, authController.revokeSession);

module.exports = router;
