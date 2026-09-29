const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { maskPhone } = require("../utils/phone");
const authService = require("./auth.service");
const otpService = require("./otp.service");

const PHONE_VERIFY_STAGE = "phone_verify";

/** Strips every secret/internal field before a user object is sent to a client. */
const sanitizeUser = (user) => {
  // toJSON applies the User model's transform (drops secrets and session token hashes)
  const obj = typeof user.toJSON === "function" ? user.toJSON() : { ...user };
  for (const key of [
    "password",
    "twoFactorSecret",
    "twoFactorRecoveryCodes",
    "refreshTokens",
    "pendingPhone",
    "passwordResetToken",
    "passwordResetExpires",
    "failedLoginAttempts",
    "lockUntil"
  ]) {
    delete obj[key];
  }
  return obj;
};

/**
 * Starts (or resumes) mobile verification for a customer.
 * `user` must be loaded with "+pendingPhone".
 * Sends an OTP when a pending number exists; a cooldown/limit is reported to the
 * client instead of failing, so the user can still reach the code screen.
 */
const startPhoneVerification = async (req, user, { trusted = true } = {}) => {
  const verificationToken = authService.signStepToken(user._id, PHONE_VERIFY_STAGE, "15m", { trusted });
  const phone = user.pendingPhone;

  const result = {
    verificationToken,
    needsPhone: !phone,
    phoneMasked: phone ? maskPhone(phone) : null,
    otpSent: false,
    resendAfterSeconds: 0
  };
  if (!phone) return result;

  try {
    const sent = await otpService.sendOtp({
      phone,
      purpose: "verify_phone",
      userId: user._id,
      ipAddress: req.ip
    });
    result.otpSent = true;
    result.resendAfterSeconds = sent.resendAfterSeconds;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    logger.warn(`Phone verification OTP not sent for user ${user._id}: ${err.message}`);
    result.resendAfterSeconds = err.errors?.[0]?.resendAfterSeconds || 0;
    result.otpMessage = err.message;
  }
  return result;
};

module.exports = { sanitizeUser, startPhoneVerification, PHONE_VERIFY_STAGE };
