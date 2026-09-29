const express = require("express");
const router = express.Router();

const controller = require("../controllers/customerAuth.controller");
const validate = require("../middlewares/validate.middleware");
const { authLimiter, createLimiter } = require("../middlewares/rateLimiter.middleware");
const {
  customerRegisterSchema,
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

// Signup page: is this referral code valid? (only the friend's first name comes back)
const referralCheckLimiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 30, message: "Too many requests." });
router.get("/referral/:code", referralCheckLimiter, async (req, res, next) => {
  try {
    const code = String(req.params.code || "");
    if (!/^[A-Za-z0-9-]{4,20}$/.test(code)) return res.status(200).json({ success: true, data: { valid: false } });
    const data = await require("../services/referrals.service").checkCode(code);
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// Public customer auth routes (no session yet)
router.post("/register", authLimiter, otpSendLimiter, validate(customerRegisterSchema), controller.register);
router.post("/otp/send", otpSendLimiter, validate(sendVerificationOtpSchema), controller.sendVerificationOtp);
router.post("/otp/verify", otpVerifyLimiter, validate(verifyPhoneSchema), controller.verifyPhone);
router.post("/password/otp", otpSendLimiter, validate(passwordResetOtpSchema), controller.requestPasswordResetOtp);
router.post("/password/reset", otpVerifyLimiter, validate(passwordResetWithOtpSchema), controller.resetPasswordWithOtp);

module.exports = router;
