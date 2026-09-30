const User = require("../models/User");
const config = require("../config/env");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../utils/logger");
const { maskPhone } = require("../utils/phone");
const { ROLES } = require("../config/roles");
const { recordAuditLog } = require("../services/audit.service");
const authService = require("../services/auth.service");
const otpService = require("../services/otp.service");
const {
  sanitizeUser,
  startPhoneVerification,
  PHONE_VERIFY_STAGE
} = require("../services/customerAuth.service");

const ACCOUNT_EXISTS_MESSAGE =
  "An account with this email or mobile number already exists. Sign in or reset your password.";
const PHONE_TAKEN_MESSAGE = "This mobile number is already linked to another account.";

const isDuplicateKey = (err) => err && err.code === 11000;

/** Loads the customer behind a phone-verification step token. */
const loadPendingCustomer = async (verificationToken, select = "+pendingPhone") => {
  const decoded = authService.verifyStepToken(verificationToken, PHONE_VERIFY_STAGE);
  const user = await User.findById(decoded.userId).select(select);
  if (!user || user.role !== ROLES.CUSTOMER) {
    throw new ApiError(401, "Your verification session has expired. Please sign in again.", [
      { code: "STEP_TOKEN_INVALID" }
    ]);
  }
  if (user.status === "suspended" || user.status === "inactive") {
    throw new ApiError(403, `Your account is ${user.status}. Contact Bonito support.`);
  }
  return user;
};

/**
 * POST /customer/auth/register
 * Creates a customer (role is always "customer") and sends an OTP to the
 * mobile number. The number becomes the account's phone only once verified.
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, phone, authKey, kdfSalt } = req.body;
  const staffDomains = String(process.env.STAFF_EMAIL_DOMAINS || "bonito.in").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (staffDomains.some((d) => String(email).toLowerCase().endsWith(`@${d}`))) {
    throw new ApiError(400, "Bonito staff addresses can't be used for customer accounts.");
  }

  const [emailTaken, phoneTaken] = await Promise.all([
    User.exists({ email }),
    User.exists({ phone })
  ]);
  if (emailTaken || phoneTaken) {
    throw new ApiError(409, ACCOUNT_EXISTS_MESSAGE, [{ code: "ACCOUNT_EXISTS" }]);
  }

  let user;
  try {
    user = new User({
      name,
      email,
      pendingPhone: phone,
      role: ROLES.CUSTOMER,
      createdBy: null,
      consent: { termsAcceptedAt: new Date(), privacyVersion: config.privacyPolicyVersion },
      notificationPrefs: { whatsapp: Boolean(req.body.projectAlerts), sms: false, updatedAt: new Date() }
    });
    user.setDerivedCredential(authKey, kdfSalt);
    await user.save();
  } catch (err) {
    if (isDuplicateKey(err)) throw new ApiError(409, ACCOUNT_EXISTS_MESSAGE, [{ code: "ACCOUNT_EXISTS" }]);
    throw err;
  }

  if (req.body.referralCode) {
    await require("../services/referrals.service").recordSignup({ referred: user, code: req.body.referralCode });
  }

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "customer_registered",
    targetType: "User",
    targetId: user._id,
    metadata: { email: email.replace(/^(.).*(@.*)$/, "$1***$2"), phone: maskPhone(phone), privacyVersion: config.privacyPolicyVersion }
  });

  const verification = await startPhoneVerification(req, user);
  res
    .status(201)
    .json(new ApiResponse(201, { requiresPhoneVerification: true, ...verification }, "Account created. Verify your mobile number."));
});

/**
 * POST /customer/auth/otp/send
 * Resends the verification code, or sets the number first for customers who
 * signed up before phone verification existed.
 */
const sendVerificationOtp = asyncHandler(async (req, res) => {
  const { verificationToken, phone } = req.body;
  const user = await loadPendingCustomer(verificationToken);

  if (user.phoneVerified) {
    throw new ApiError(400, "Your mobile number is already verified. Please sign in.");
  }

  if (phone && phone !== user.pendingPhone) {
    const taken = await User.exists({ phone, _id: { $ne: user._id } });
    if (taken) throw new ApiError(409, PHONE_TAKEN_MESSAGE, [{ code: "PHONE_TAKEN" }]);
    user.pendingPhone = phone;
    await user.save({ validateBeforeSave: false });
  }

  if (!user.pendingPhone) {
    throw new ApiError(400, "Enter your mobile number to continue.", [{ code: "PHONE_REQUIRED" }]);
  }

  const sent = await otpService.sendOtp({
    phone: user.pendingPhone,
    purpose: "verify_phone",
    userId: user._id,
    ipAddress: req.ip
  });

  res.status(200).json(
    new ApiResponse(200, { phoneMasked: maskPhone(user.pendingPhone), ...sent }, "Verification code sent")
  );
});

/**
 * POST /customer/auth/otp/verify
 * Verifies the code, attaches the number to the account and signs the user in.
 */
const verifyPhone = asyncHandler(async (req, res) => {
  const { verificationToken, code } = req.body;
  const { trusted = true } = authService.verifyStepToken(verificationToken, PHONE_VERIFY_STAGE);
  const user = await loadPendingCustomer(verificationToken, "+pendingPhone +refreshTokens");

  if (!user.pendingPhone) {
    throw new ApiError(400, "Enter your mobile number to continue.", [{ code: "PHONE_REQUIRED" }]);
  }

  await otpService.verifyOtp({ phone: user.pendingPhone, purpose: "verify_phone", code });

  const taken = await User.exists({ phone: user.pendingPhone, _id: { $ne: user._id } });
  if (taken) throw new ApiError(409, PHONE_TAKEN_MESSAGE, [{ code: "PHONE_TAKEN" }]);

  const verifiedPhone = user.pendingPhone;
  user.phone = verifiedPhone;
  user.phoneVerified = true;
  user.pendingPhone = undefined;

  let accessToken = null;
  try {
    if (user.isTwoFactorEnabled) {
      await user.save();
    } else {
      ({ accessToken } = await authService.issueSession(req, res, user, { trusted })); // also saves the user
    }
  } catch (err) {
    if (isDuplicateKey(err)) throw new ApiError(409, PHONE_TAKEN_MESSAGE, [{ code: "PHONE_TAKEN" }]);
    throw err;
  }

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "customer_phone_verified",
    targetType: "User",
    targetId: user._id,
    metadata: { phone: maskPhone(verifiedPhone) }
  });

  if (user.isTwoFactorEnabled) {
    const tempToken = authService.signStepToken(user._id, "2fa_pending", "5m", { trusted });
    return res
      .status(200)
      .json(new ApiResponse(200, { requires2FA: true, tempToken }, "Mobile verified. 2FA verification required."));
  }

  res.status(200).json(new ApiResponse(200, { user: sanitizeUser(user) }, "Mobile number verified"));
});

const GENERIC_RESET_MESSAGE = "If this number is registered, we've sent a 6-digit code to it.";

/**
 * POST /customer/auth/password/otp
 * Always answers the same way so it can't be used to discover registered numbers.
 */
const requestPasswordResetOtp = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  const user = await User.findOne({ phone, status: "active" }).select("_id");

  if (user) {
    try {
      await otpService.sendOtp({ phone, purpose: "reset_password", userId: user._id, ipAddress: req.ip });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      logger.warn(`Password reset OTP not sent to ${maskPhone(phone)}: ${err.message}`);
    }
  }

  res.status(200).json(new ApiResponse(200, { resendAfterSeconds: 30 }, GENERIC_RESET_MESSAGE));
});

/**
 * POST /customer/auth/password/reset
 * Resets the password with a phone OTP and signs out every device.
 */
const resetPasswordWithOtp = asyncHandler(async (req, res) => {
  const { phone, code, authKey, kdfSalt } = req.body;

  await otpService.verifyOtp({ phone, purpose: "reset_password", code });

  const user = await User.findOne({ phone }).select("+refreshTokens");
  if (!user) throw new ApiError(400, "Invalid or expired code.", [{ code: "OTP_INVALID" }]);

  user.setDerivedCredential(authKey, kdfSalt);
  user.keyBundle = undefined; // encrypted with the old password — can no longer be opened
  user.mustChangePassword = false;
  user.tokenVersion += 1;
  user.refreshTokens = [];
  user.currentSessions = [];
  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  await user.save();
  require("../sockets").disconnectSessions(user._id).catch(() => {});

  authService.clearTokenCookies(res);

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "password_reset_via_phone",
    targetType: "User",
    targetId: user._id,
    metadata: { phone: maskPhone(phone) }
  });

  res.status(200).json(new ApiResponse(200, null, "Password reset. Please sign in with your new password."));
});

module.exports = {
  register,
  sendVerificationOtp,
  verifyPhone,
  requestPasswordResetOtp,
  resetPasswordWithOtp
};
