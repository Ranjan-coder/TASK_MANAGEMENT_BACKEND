const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../utils/logger");
const { maskPhone } = require("../utils/phone");
const { ROLES } = require("../config/roles");
const { recordAuditLog } = require("../services/audit.service");
const authService = require("../services/auth.service");
const otpService = require("../services/otp.service");
const { findAccounts, findUserById, enterUserOrg } = require("../services/accountLookup.service");
const { getOrgStatus, getManyPublic, orgHasModule } = require("../services/organisation.service");
const {
  signedInUser,
  startPhoneVerification,
  PHONE_VERIFY_STAGE
} = require("../services/customerAuth.service");

const PHONE_TAKEN_MESSAGE = "This mobile number is already linked to another account.";
// After a verified reset code, someone with accounts in several organisations picks one
const RESET_CHOOSE_ORG_STAGE = "reset_choose_org";

const isDuplicateKey = (err) => err && err.code === 11000;

/** Loads the customer behind a phone-verification step token, scoped to their organisation. */
const loadPendingCustomer = async (verificationToken, select = "+pendingPhone") => {
  const decoded = authService.verifyStepToken(verificationToken, PHONE_VERIFY_STAGE);
  const user = await findUserById(decoded.userId, select);
  if (!user || user.role !== ROLES.CUSTOMER) {
    throw new ApiError(401, "Your verification session has expired. Please sign in again.", [
      { code: "STEP_TOKEN_INVALID" }
    ]);
  }
  if (user.status === "suspended" || user.status === "inactive") {
    throw new ApiError(403, `Your account is ${user.status}. Contact support.`);
  }
  if ((await getOrgStatus(user.orgId)) !== "active") {
    throw new ApiError(403, "Your organisation's access is paused. Contact your administrator.", [{ code: "ORG_SUSPENDED" }]);
  }
  if (!(await orgHasModule(user.orgId, "customer_portal"))) {
    throw new ApiError(403, "The customer portal isn't available for your organisation.", [{ code: "MODULE_DISABLED", module: "customer_portal" }]);
  }
  // Phone uniqueness checks below are per organisation (M5)
  enterUserOrg(user);
  return user;
};

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
    // Same single-use step as a password sign-in (auth.controller verify2FA)
    const jti = require("crypto").randomBytes(16).toString("hex");
    await User.updateOne({ _id: user._id }, { $set: { twoFactorStepJti: jti } });
    const tempToken = authService.signStepToken(user._id, "2fa_pending", "5m", { trusted, jti });
    return res
      .status(200)
      .json(new ApiResponse(200, { requires2FA: true, tempToken }, "Mobile verified. 2FA verification required."));
  }

  res.status(200).json(new ApiResponse(200, { user: await signedInUser(user) }, "Mobile number verified"));
});

const GENERIC_RESET_MESSAGE = "If this number is registered, we've sent a 6-digit code to it.";

/**
 * POST /customer/auth/password/otp
 * Always answers the same way so it can't be used to discover registered numbers.
 */
const requestPasswordResetOtp = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  // Answer first, the same way for every number; the lookup and the SMS happen
  // afterwards, so the response time can't reveal a registered number either
  res.status(200).json(new ApiResponse(200, { resendAfterSeconds: 30 }, GENERIC_RESET_MESSAGE));

  try {
    // The code proves the phone, whichever organisations it has accounts in
    const [user] = await findAccounts({ phone }, { select: "_id", extra: { status: "active" } });
    if (user) await otpService.sendOtp({ phone, purpose: "reset_password", userId: user._id, ipAddress: req.ip });
  } catch (err) {
    logger.warn(`Password reset OTP not sent to ${maskPhone(phone)}: ${err.message}`);
  }
});

/**
 * POST /customer/auth/password/reset
 * Resets the password with a phone OTP and signs out every device.
 */
const resetPasswordWithOtp = asyncHandler(async (req, res) => {
  const { code, resetToken, organisation, authKey, kdfSalt } = req.body;
  let { phone } = req.body;

  let stepToken = null;
  if (resetToken) {
    // Second step: the code was already verified, the person picked an organisation
    stepToken = authService.verifyStepToken(resetToken, RESET_CHOOSE_ORG_STAGE);
    ({ phone } = stepToken);
  } else {
    await otpService.verifyOtp({ phone, purpose: "reset_password", code });
  }

  const accounts = await findAccounts({ phone }, { organisation, select: "+refreshTokens", extra: { status: "active" } });
  if (!accounts.length) throw new ApiError(400, "Invalid or expired code.", [{ code: "OTP_INVALID" }]);

  if (accounts.length > 1) {
    // The phone is proven, so its owner may see which organisations it belongs to
    const orgs = await getManyPublic(accounts.map((a) => a.orgId));
    const choices = [...orgs.values()].filter((o) => o.status === "active").map((o) => ({ slug: o.slug, name: o.name }));
    return res.status(200).json(
      new ApiResponse(
        200,
        { chooseOrganisation: true, organisations: choices, resetToken: authService.signStepToken(null, RESET_CHOOSE_ORG_STAGE, "10m", { phone, jti: require("crypto").randomBytes(16).toString("hex") }) },
        "Choose which organisation's password to reset"
      )
    );
  }

  const [user] = accounts;
  // One reset per verified code: used up only now, once an account was chosen
  if (stepToken) await authService.consumeStepToken(stepToken);
  enterUserOrg(user);

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
  sendVerificationOtp,
  verifyPhone,
  requestPasswordResetOtp,
  resetPasswordWithOtp
};
