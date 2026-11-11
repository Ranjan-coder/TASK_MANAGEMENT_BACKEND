const express = require("express");
const router = express.Router();
// Sign-in starts without an organisation (see middlewares/publicTenant)
router.use(require("../middlewares/publicTenant.middleware"));

const controller = require("../controllers/customerAuth.controller");
const validate = require("../middlewares/validate.middleware");
const { createLimiter } = require("../middlewares/rateLimiter.middleware");
const {
  sendVerificationOtpSchema,
  verifyPhoneSchema,
  passwordResetOtpSchema,
  passwordResetWithOtpSchema
} = require("../validators/customerAuth.validator");

// Per-IP limits on top of the per-phone limits in otp.service
const otpSendLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Too many code requests from this network. Please try again later."
});
const otpVerifyLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many verification attempts. Please try again in 15 minutes."
});

// Public customer auth routes (no session yet). Customers are added by their
// organisation (module-access-plan.md, M2): there is no public sign-up.
router.post("/otp/send", otpSendLimiter, validate(sendVerificationOtpSchema), controller.sendVerificationOtp);
router.post("/otp/verify", otpVerifyLimiter, validate(verifyPhoneSchema), controller.verifyPhone);
router.post("/password/otp", otpSendLimiter, validate(passwordResetOtpSchema), controller.requestPasswordResetOtp);
router.post("/password/reset", otpVerifyLimiter, validate(passwordResetWithOtpSchema), controller.resetPasswordWithOtp);

module.exports = router;
