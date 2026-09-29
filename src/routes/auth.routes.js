const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const validate = require("../middlewares/validate.middleware");
const { authLimiter, createLimiter } = require("../middlewares/rateLimiter.middleware");

// 5 sign-in tries per account per network every 15 minutes (on top of the per-network limit)
const perAccountLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many sign-in attempts for this account. Please wait 15 minutes.",
  keyGenerator: (req) => `login:${String(req.body?.identifier || "").trim().toLowerCase().replace(/\s+/g, "")}:${req.ip}`
});

const preloginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many sign-in attempts. Please try again in 15 minutes."
});
const rbacMiddleware = require("../middlewares/rbac.middleware");
const {
  loginSchema,
  verify2FASchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  preloginSchema,
  disable2FASchema
} = require("../validators/auth.validator");

// Public Auth Routes
// Public sign-up lives at /customer/auth/register (phone-verified customers only)
router.post("/prelogin", preloginLimiter, validate(preloginSchema), authController.prelogin);
router.post("/login", authLimiter, validate(loginSchema), perAccountLimiter, authController.login);
router.post("/2fa/verify", authLimiter, validate(verify2FASchema), authController.verify2FA);
router.post("/refresh", authController.refreshToken);
router.post("/forgot-password", authLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post("/reset-password/:token", authLimiter, validate(resetPasswordSchema), authController.resetPassword);

// Authenticated Routes
router.post("/2fa/setup", authMiddleware, authController.setup2FA);
router.post("/2fa/enable", authMiddleware, authController.enable2FA);
router.post("/2fa/disable", authMiddleware, authLimiter, validate(disable2FASchema), authController.disable2FA);
router.post("/logout", authMiddleware, authController.logout);
router.post(
  "/change-password",
  authLimiter,
  authMiddleware,
  validate(changePasswordSchema),
  authController.changePassword
);
router.get("/me", authMiddleware, authController.getMe);
router.get("/kdf", authMiddleware, authController.getOwnKdf);

// Session Management
router.get("/sessions", authMiddleware, authController.getSessions);
router.post("/sessions/revoke-all", authMiddleware, authController.revokeAllSessions);
router.post("/sessions/revoke-others", authMiddleware, authController.revokeOtherSessions);
router.delete("/sessions/:id", authMiddleware, authController.revokeSession);

module.exports = router;
