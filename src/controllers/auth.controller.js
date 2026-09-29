const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const config = require("../config/env");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const authService = require("../services/auth.service");
const twoFactorService = require("../services/twoFactor.service");
const { recordAuditLog } = require("../services/audit.service");
const { ROLES } = require("../config/roles");
const { normalizeIndianMobile, looksLikeEmail } = require("../utils/phone");
const { startPhoneVerification, sanitizeUser } = require("../services/customerAuth.service");
const { kdfParams, fakeSalt, newSalt } = require("../utils/kdf");
const { disconnectSessions } = require("../sockets");

/** One canonical form per identifier (so "9876543210" and "+91 98765 43210" behave the same). */
const canonicalIdentifier = (identifier) =>
  looksLikeEmail(identifier) ? String(identifier).trim().toLowerCase() : normalizeIndianMobile(identifier) || String(identifier).trim().toLowerCase();

// Used when an account doesn't exist, so a wrong guess costs the same time as a real check
const DUMMY_HASH = require("bcryptjs").hashSync("bonito-timing-equaliser", 12);
const SIGN_IN_FAILED = "Invalid credentials. After several failed attempts, sign-in is paused for 15 minutes.";

/** Finds a user by email or verified mobile number. */
const findByIdentifier = async (identifier, select) => {
  if (looksLikeEmail(identifier)) return User.findOne({ email: identifier.toLowerCase() }).select(select);
  const phone = normalizeIndianMobile(identifier);
  return phone ? User.findOne({ phone }).select(select) : null;
};

/**
 * POST /auth/prelogin
 * Returns the key-derivation parameters the browser needs before login.
 * Unknown identifiers get a deterministic fake salt, so the response doesn't
 * reveal whether an account exists. `legacy: true` asks the client to also
 * send the raw password once, to migrate an account created before this scheme.
 */
const prelogin = asyncHandler(async (req, res) => {
  const { identifier } = req.body;
  const user = await findByIdentifier(identifier, "kdf authScheme");

  if (!user) {
    return res.status(200).json(new ApiResponse(200, { kdf: kdfParams(fakeSalt(canonicalIdentifier(identifier))), legacy: false }));
  }

  if (!user.kdf?.salt) {
    // First contact since the scheme was introduced: assign a salt now so the
    // client can derive the new authKey during this login.
    user.kdf = kdfParams(newSalt());
    await user.save({ validateBeforeSave: false });
  }

  res.status(200).json(
    new ApiResponse(200, {
      kdf: { algorithm: user.kdf.algorithm, iterations: user.kdf.iterations, salt: user.kdf.salt },
      legacy: user.authScheme !== "derived"
    })
  );
});

/** GET /auth/kdf — own derivation parameters (to unlock chat keys or change password). */
const getOwnKdf = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("kdf authScheme");
  const kdf = user.kdf?.salt
    ? { algorithm: user.kdf.algorithm, iterations: user.kdf.iterations, salt: user.kdf.salt }
    : null;
  res.status(200).json(new ApiResponse(200, { kdf, legacy: user.authScheme !== "derived" }));
});

/**
 * POST /auth/login
 * Email or verified phone + authKey. Customers whose phone is not verified get
 * a phone-verification step instead of a session.
 */
const login = asyncHandler(async (req, res) => {
  const { identifier, authKey, password, trustDevice } = req.body;
  const trusted = trustDevice !== false;

  const user = await findByIdentifier(
    identifier,
    "+password +twoFactorSecret +failedLoginAttempts +lockUntil +refreshTokens +pendingPhone"
  );

  if (!user) {
    await require("bcryptjs").compare(String(authKey || password || ""), DUMMY_HASH);
    throw new ApiError(401, SIGN_IN_FAILED);
  }

  // Same answer as a wrong password, so it doesn't reveal that the account exists
  if (user.isLocked()) {
    throw new ApiError(401, SIGN_IN_FAILED);
  }

  const isLegacy = user.authScheme !== "derived";
  if (isLegacy && !password) {
    throw new ApiError(400, "Please sign in again to upgrade your account security.", [
      { code: "LEGACY_PASSWORD_REQUIRED" }
    ]);
  }

  const valid = await user.verifyCredential({ authKey, password });
  if (!valid) {
    await user.incrementLoginAttempts();
    throw new ApiError(401, SIGN_IN_FAILED);
  }

  // Account status is only revealed to someone who knows the password
  if (user.status === "suspended" || user.status === "inactive") {
    throw new ApiError(403, `Your account is ${user.status}. Contact administrator.`);
  }

  await user.resetLoginAttempts();

  // One-time migration: replace bcrypt(password) with bcrypt(authKey)
  if (isLegacy) {
    if (!user.kdf?.salt) throw new ApiError(400, "Please sign in again.", [{ code: "PRELOGIN_REQUIRED" }]);
    user.setDerivedCredential(authKey, user.kdf.salt);
    await user.save();
    await recordAuditLog({ req, actorId: user._id, action: "auth_scheme_migrated", targetType: "User", targetId: user._id });
  }

  // Customers must verify their mobile number before getting a session
  if (user.role === ROLES.CUSTOMER && !user.phoneVerified) {
    const verification = await startPhoneVerification(req, user, { trusted });
    return res.status(200).json(
      new ApiResponse(200, { requiresPhoneVerification: true, ...verification }, "Verify your mobile number to continue")
    );
  }

  // If 2FA is enabled
  if (user.isTwoFactorEnabled) {
    const jti = crypto.randomBytes(16).toString("hex");
    await User.updateOne({ _id: user._id }, { $set: { twoFactorStepJti: jti } });
    const tempToken = authService.signStepToken(user._id, "2fa_pending", "5m", { trusted, jti });
    return res.status(200).json(
      new ApiResponse(200, { requires2FA: true, tempToken }, "2FA verification required")
    );
  }

  const { accessToken } = await authService.issueSession(req, res, user, { trusted });

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "user_login",
    targetType: "User",
    targetId: user._id
  });

  res.status(200).json(new ApiResponse(200, { user: sanitizeUser(user) }, "Login successful"));
});

const verify2FA = asyncHandler(async (req, res) => {
  const { tempToken, code } = req.body;

  const decoded = authService.verifyStepToken(tempToken, "2fa_pending");

  const user = await User.findById(decoded.userId).select("+twoFactorSecret +refreshTokens +failedLoginAttempts +lockUntil +twoFactorLastCode");
  if (!user || !user.twoFactorSecret) {
    throw new ApiError(400, "2FA is not configured for this account");
  }
  if (user.status === "suspended" || user.status === "inactive") {
    throw new ApiError(403, `Your account is ${user.status}. Contact administrator.`);
  }
  if (user.isLocked()) throw new ApiError(401, SIGN_IN_FAILED);
  // Each sign-in's 2FA step works once
  if (decoded.jti && user.twoFactorStepJti && user.twoFactorStepJti !== decoded.jti) {
    throw new ApiError(401, "Please sign in again.");
  }

  const isValid = twoFactorService.verify2FAToken(code, user.twoFactorSecret);
  const codeKey = crypto.createHash("sha256").update(`${user._id}:${code}`).digest("hex");
  if (!isValid || user.twoFactorLastCode === codeKey) {
    // Wrong (or replayed) codes count toward the same lock as wrong passwords
    await user.incrementLoginAttempts();
    throw new ApiError(401, "Invalid 2FA authentication code");
  }
  await User.updateOne({ _id: user._id }, { $set: { twoFactorLastCode: codeKey, twoFactorStepJti: null, failedLoginAttempts: 0 }, $unset: { lockUntil: 1 } });

  const { accessToken } = await authService.issueSession(req, res, user, { trusted: decoded.trusted !== false });

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "2fa_login_success",
    targetType: "User",
    targetId: user._id
  });

  res.status(200).json(new ApiResponse(200, { user: sanitizeUser(user) }, "2FA verified successfully"));
});

const setup2FA = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (user.isTwoFactorEnabled) {
    throw new ApiError(409, "Two-factor sign-in is already on. Turn it off first (needs your password and a current code).", [{ code: "TWO_FACTOR_ACTIVE" }]);
  }
  const { secret, encryptedSecret, qrCodeUrl, recoveryCodes, hashedCodes } =
    await twoFactorService.generate2FASecret(user.email);

  user.twoFactorSecret = encryptedSecret;
  user.twoFactorRecoveryCodes = hashedCodes;
  await user.save();

  res.status(200).json(
    new ApiResponse(
      200,
      { qrCodeUrl, recoveryCodes },
      "Scan QR code and confirm with a 6-digit code to enable 2FA"
    )
  );
});

const enable2FA = asyncHandler(async (req, res) => {
  const { code } = req.body;
  const user = await User.findById(req.user._id).select("+twoFactorSecret");

  if (!user.twoFactorSecret) {
    throw new ApiError(400, "Please initiate 2FA setup first");
  }

  const isValid = twoFactorService.verify2FAToken(code, user.twoFactorSecret);
  if (!isValid) {
    throw new ApiError(400, "Invalid verification code");
  }

  user.isTwoFactorEnabled = true;
  await user.save();

  await recordAuditLog({
    req,
    action: "2fa_enabled",
    targetType: "User",
    targetId: user._id
  });

  res.status(200).json(new ApiResponse(200, null, "2FA successfully enabled"));
});

const refreshToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken = req.cookies.refreshToken || req.body.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Refresh token required");
  }

  let decoded;
  try {
    decoded = jwt.verify(incomingRefreshToken, config.jwt.refreshSecret);
  } catch {
    throw new ApiError(401, "Invalid or expired refresh token");
  }
  if (!decoded.sid) {
    throw new ApiError(401, "Please sign in again.", [{ code: "DEVICE_SIGNED_OUT" }]);
  }

  const user = await User.findById(decoded.userId).select("+tokenVersion");
  if (!user) {
    throw new ApiError(401, "Refresh token is invalid");
  }
  if (user.status === "suspended" || user.status === "inactive") {
    throw new ApiError(403, `Account is currently ${user.status}. Access denied.`);
  }

  // Token version verification (password reset / "sign out everywhere")
  if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
    throw new ApiError(401, "Session revoked");
  }

  const { accessToken } = await authService.rotateSession(res, user, decoded, incomingRefreshToken);
  res.status(200).json(new ApiResponse(200, null, "Token refreshed successfully"));
});

const logout = asyncHandler(async (req, res) => {
  if (req.user && req.sessionId) {
    await User.updateOne({ _id: req.user._id }, { $pull: { currentSessions: { sessionId: req.sessionId } } });
    disconnectSessions(req.user._id, [req.sessionId]).catch(() => {});
  }

  authService.clearTokenCookies(res);
  res.status(200).json(new ApiResponse(200, null, "Logged out successfully"));
});

const getMe = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, req.user, "Current user profile fetched"));
});

/** Signs out every device, including this one. */
const revokeAllSessions = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  user.tokenVersion += 1;
  user.refreshTokens = [];
  user.currentSessions = [];
  await user.save();
  disconnectSessions(user._id).catch(() => {});

  authService.clearTokenCookies(res);

  await recordAuditLog({
    req,
    action: "all_sessions_revoked",
    targetType: "User",
    targetId: user._id
  });

  res.status(200).json(new ApiResponse(200, null, "All sessions have been revoked"));
});

/** Signs out every device except the one making the request. */
const revokeOtherSessions = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  const others = user.currentSessions.filter((s) => s.sessionId !== req.sessionId).map((s) => s.sessionId);
  user.currentSessions = user.currentSessions.filter((s) => s.sessionId === req.sessionId);
  await user.save();
  disconnectSessions(user._id, others).catch(() => {});

  await recordAuditLog({
    req,
    action: "other_sessions_revoked",
    targetType: "User",
    targetId: user._id,
    metadata: { count: others.length }
  });

  res.status(200).json(new ApiResponse(200, { signedOut: others.length }, "Other devices signed out"));
});

const disable2FA = asyncHandler(async (req, res) => {
  const { authKey, password, code } = req.body;
  const user = await User.findById(req.user._id).select("+password +twoFactorSecret +failedLoginAttempts +lockUntil");
  if (user.isLocked()) throw new ApiError(401, SIGN_IN_FAILED);

  const isPasswordValid = await user.verifyCredential({ authKey, password });
  const codeValid = Boolean(user.twoFactorSecret) && twoFactorService.verify2FAToken(code, user.twoFactorSecret);
  if (!isPasswordValid || !codeValid) {
    await user.incrementLoginAttempts(); // guesses count toward the account lock
    throw new ApiError(401, "Wrong password or code. 2FA is still on.");
  }

  user.isTwoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  user.twoFactorRecoveryCodes = [];
  user.tokenVersion += 1; // revoke all existing sessions
  user.currentSessions = [];
  await user.save();
  await disconnectSessions(user._id);

  authService.clearTokenCookies(res);

  await recordAuditLog({
    req,
    action: "2fa_disabled",
    targetType: "User",
    targetId: user._id
  });

  res.status(200).json(new ApiResponse(200, null, "2FA has been disabled. Please log in again."));
});

/** Signed-in devices. The refresh token hashes are never sent. */
const getSessions = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  res.status(200).json(new ApiResponse(200, authService.describeSessions(user, req.sessionId), "Active sessions fetched"));
});

/**
 * Signs out one device: its session (and refresh token) is removed, so its
 * access token stops working immediately and it can't refresh.
 */
const revokeSession = asyncHandler(async (req, res) => {
  const { id: sessionId } = req.params;
  const result = await User.updateOne(
    { _id: req.user._id, "currentSessions.sessionId": sessionId },
    { $pull: { currentSessions: { sessionId } } }
  );
  if (result.modifiedCount === 0) {
    throw new ApiError(404, "Session not found");
  }
  disconnectSessions(req.user._id, [sessionId]).catch(() => {});

  if (sessionId === req.sessionId) authService.clearTokenCookies(res);

  await recordAuditLog({
    req,
    action: "session_revoked",
    targetType: "User",
    targetId: req.user._id,
    metadata: { sessionId }
  });

  res.status(200).json(new ApiResponse(200, null, "Device signed out"));
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  // Always return success to prevent email enumeration
  if (!user) {
    return res
      .status(200)
      .json(
        new ApiResponse(200, null, "If that email is registered, a reset link has been sent.")
      );
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

  user.passwordResetToken = hashedToken;
  user.passwordResetExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  await user.save({ validateBeforeSave: false });

  const resetUrl = `${config.clientUrl}/reset-password/${resetToken}`;
  const { addEmailJob } = require("../jobs/queue");
  await addEmailJob({
    to: user.email,
    subject: "Password Reset Request",
    html: `<p>You requested a password reset. Click the link below within 15 minutes:</p><a href="${resetUrl}">${resetUrl}</a><p>If you did not request this, ignore this email.</p>`
  });

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "password_reset_requested",
    targetType: "User",
    targetId: user._id
  });

  res
    .status(200)
    .json(new ApiResponse(200, null, "If that email is registered, a reset link has been sent."));
});

/**
 * Resets the password with an emailed token. The old key bundle was encrypted
 * with a key derived from the old password, so it can no longer be opened and
 * is removed; chat keys are then re-shared by group members or restored from
 * another device (customer-portal-plan.md §4.3).
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { authKey, kdfSalt } = req.body;

  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() }
  }).select("+passwordResetToken +passwordResetExpires");

  if (!user) {
    throw new ApiError(400, "Password reset token is invalid or has expired");
  }

  user.setDerivedCredential(authKey, kdfSalt);
  user.keyBundle = undefined;
  user.mustChangePassword = false;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.tokenVersion += 1; // invalidate all active sessions
  user.refreshTokens = [];
  user.currentSessions = [];
  await user.save();

  disconnectSessions(user._id).catch(() => {});

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "password_reset_completed",
    targetType: "User",
    targetId: user._id
  });

  res.status(200).json(new ApiResponse(200, null, "Password reset successful. Please log in."));
});

/**
 * Change password for the logged-in user (also clears a forced-change flag).
 * The browser re-encrypts the chat key bundle with the new wrapKey and sends it
 * in the same request, so the credential and the bundle never get out of step.
 * Revokes every other session and issues fresh tokens for this one.
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentAuthKey, currentPassword, newAuthKey, newKdfSalt, keyBundle } = req.body;

  const user = await User.findById(req.user._id).select("+password +refreshTokens +keyBundle");
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const isPasswordValid = await user.verifyCredential({ authKey: currentAuthKey, password: currentPassword });
  if (!isPasswordValid) {
    await user.incrementLoginAttempts();
    throw new ApiError(401, "Current password is incorrect");
  }

  if (user.keyBundle && !keyBundle) {
    throw new ApiError(400, "Your chat keys must be re-encrypted with the new password. Please try again.", [
      { code: "KEY_BUNDLE_REQUIRED" }
    ]);
  }

  user.setDerivedCredential(newAuthKey, newKdfSalt);
  if (keyBundle) {
    user.keyBundle = {
      ciphertext: keyBundle.ciphertext,
      iv: keyBundle.iv,
      version: (user.keyBundle?.version || 0) + 1,
      updatedAt: new Date()
    };
  }
  const trusted = user.currentSessions.find((s) => s.sessionId === req.sessionId)?.trusted !== false;
  const signedOut = user.currentSessions.map((s) => s.sessionId);
  user.mustChangePassword = false;
  user.tokenVersion += 1;
  user.refreshTokens = [];
  user.currentSessions = [];

  // Every other device is signed out; this one gets a fresh session
  const { accessToken } = await authService.issueSession(req, res, user, { trusted, alert: false });
  disconnectSessions(user._id, signedOut).catch(() => {});

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "password_changed",
    targetType: "User",
    targetId: user._id
  });

  res
    .status(200)
    .json(new ApiResponse(200, { user: sanitizeUser(user) }, "Password changed. Other devices have been signed out."));
});

module.exports = {
  prelogin,
  getOwnKdf,
  changePassword,
  login,
  verify2FA,
  setup2FA,
  enable2FA,
  disable2FA,
  refreshToken,
  logout,
  getMe,
  getSessions,
  revokeSession,
  revokeAllSessions,
  revokeOtherSessions,
  forgotPassword,
  resetPassword
};
