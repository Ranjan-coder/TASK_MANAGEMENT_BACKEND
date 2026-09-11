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

const register = asyncHandler(async (req, res) => {
  const { name, email, password, role, department, designation } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new ApiError(409, "User with this email already exists");
  }

  const user = await User.create({
    name,
    email,
    password,
    role: role || "user",
    department,
    designation,
    createdBy: req.user?._id || null
  });

  await recordAuditLog({
    req,
    action: "user_registered",
    targetType: "User",
    targetId: user._id,
    metadata: { email, role: user.role }
  });

  const userResponse = user.toObject();
  delete userResponse.password;

  res.status(201).json(new ApiResponse(201, userResponse, "User registered successfully"));
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select(
    "+password +twoFactorSecret +failedLoginAttempts +lockUntil +refreshTokens"
  );

  if (!user) {
    throw new ApiError(401, "Invalid email or password");
  }

  if (user.isLocked()) {
    throw new ApiError(423, "Account is temporarily locked due to failed attempts. Try again later.");
  }

  if (user.status === "suspended" || user.status === "inactive") {
    throw new ApiError(403, `Your account is ${user.status}. Contact administrator.`);
  }

  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    await user.incrementLoginAttempts();
    throw new ApiError(401, "Invalid email or password");
  }

  await user.resetLoginAttempts();

  // If 2FA is enabled
  if (user.isTwoFactorEnabled) {
    const tempToken = jwt.sign(
      { userId: user._id, stage: "2fa_pending" },
      config.jwt.accessSecret,
      { expiresIn: "5m" }
    );
    return res.status(200).json(
      new ApiResponse(200, { requires2FA: true, tempToken }, "2FA verification required")
    );
  }

  const { accessToken, refreshToken } = authService.generateTokens(user);
  const hashedRefreshToken = authService.hashToken(refreshToken);

  const sessionId = crypto.randomUUID();
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const device = req.headers["user-agent"] || "unknown device";

  user.refreshTokens = user.refreshTokens || [];
  user.currentSessions = user.currentSessions || [];
  user.refreshTokens.push(hashedRefreshToken);
  user.lastLogin = new Date();
  user.currentSessions.push({ sessionId, device, ipAddress, lastActive: new Date() });
  await user.save();

  authService.setTokenCookies(res, accessToken, refreshToken);

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "user_login",
    targetType: "User",
    targetId: user._id
  });

  const userObj = user.toObject();
  delete userObj.password;
  delete userObj.twoFactorSecret;

  res.status(200).json(new ApiResponse(200, { user: userObj, accessToken }, "Login successful"));
});

const verify2FA = asyncHandler(async (req, res) => {
  const { tempToken, code } = req.body;

  let decoded;
  try {
    decoded = jwt.verify(tempToken, config.jwt.accessSecret);
    if (decoded.stage !== "2fa_pending") {
      throw new Error();
    }
  } catch {
    throw new ApiError(401, "Invalid or expired 2FA session token");
  }

  const user = await User.findById(decoded.userId).select("+twoFactorSecret +refreshTokens");
  if (!user || !user.twoFactorSecret) {
    throw new ApiError(400, "2FA is not configured for this account");
  }

  const isValid = twoFactorService.verify2FAToken(code, user.twoFactorSecret);
  if (!isValid) {
    throw new ApiError(401, "Invalid 2FA authentication code");
  }

  const { accessToken, refreshToken } = authService.generateTokens(user);
  const hashedRefreshToken = authService.hashToken(refreshToken);

  user.refreshTokens = user.refreshTokens || [];
  user.refreshTokens.push(hashedRefreshToken);
  user.lastLogin = new Date();
  await user.save();

  authService.setTokenCookies(res, accessToken, refreshToken);

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "2fa_login_success",
    targetType: "User",
    targetId: user._id
  });

  const userObj = user.toObject();
  delete userObj.password;
  delete userObj.twoFactorSecret;

  res.status(200).json(new ApiResponse(200, { user: userObj, accessToken }, "2FA verified successfully"));
});

const setup2FA = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
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

  const hashedToken = authService.hashToken(incomingRefreshToken);
  const user = await User.findById(decoded.userId).select("+refreshTokens +tokenVersion");

  if (!user || !user.refreshTokens.includes(hashedToken)) {
    throw new ApiError(401, "Refresh token is invalid or has been reused");
  }

  // Token version verification
  if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
    throw new ApiError(401, "Session revoked");
  }

  // Rotate token: Remove old hash, create new pair
  user.refreshTokens = user.refreshTokens.filter((t) => t !== hashedToken);
  const tokens = authService.generateTokens(user);
  user.refreshTokens.push(authService.hashToken(tokens.refreshToken));
  await user.save();

  authService.setTokenCookies(res, tokens.accessToken, tokens.refreshToken);

  res.status(200).json(
    new ApiResponse(200, { accessToken: tokens.accessToken }, "Token refreshed successfully")
  );
});

const logout = asyncHandler(async (req, res) => {
  const incomingRefreshToken = req.cookies?.refreshToken;
  if (incomingRefreshToken && req.user) {
    const hashed = authService.hashToken(incomingRefreshToken);
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { refreshTokens: hashed }
    });
  }

  authService.clearTokenCookies(res);
  res.status(200).json(new ApiResponse(200, null, "Logged out successfully"));
});

const getMe = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, req.user, "Current user profile fetched"));
});

const revokeAllSessions = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  user.tokenVersion += 1;
  user.refreshTokens = [];
  user.currentSessions = [];
  await user.save();

  authService.clearTokenCookies(res);

  await recordAuditLog({
    req,
    action: "all_sessions_revoked",
    targetType: "User",
    targetId: user._id
  });

  res.status(200).json(new ApiResponse(200, null, "All sessions have been revoked"));
});

const disable2FA = asyncHandler(async (req, res) => {
  const { password } = req.body;
  const user = await User.findById(req.user._id).select("+password +twoFactorSecret");

  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid password. Cannot disable 2FA.");
  }

  user.isTwoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  user.twoFactorRecoveryCodes = [];
  user.tokenVersion += 1; // revoke all existing sessions
  await user.save();

  authService.clearTokenCookies(res);

  await recordAuditLog({
    req,
    action: "2fa_disabled",
    targetType: "User",
    targetId: user._id
  });

  res.status(200).json(new ApiResponse(200, null, "2FA has been disabled. Please log in again."));
});

const getSessions = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  res.status(200).json(new ApiResponse(200, user.currentSessions, "Active sessions fetched"));
});

const revokeSession = asyncHandler(async (req, res) => {
  const { id: sessionId } = req.params;
  const user = await User.findById(req.user._id);

  const sessionIndex = user.currentSessions.findIndex(
    (s) => s.sessionId === sessionId
  );
  if (sessionIndex === -1) {
    throw new ApiError(404, "Session not found");
  }

  user.currentSessions.splice(sessionIndex, 1);
  await user.save();

  res.status(200).json(new ApiResponse(200, null, "Session revoked successfully"));
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

const resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() }
  }).select("+passwordResetToken +passwordResetExpires");

  if (!user) {
    throw new ApiError(400, "Password reset token is invalid or has expired");
  }

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.tokenVersion += 1; // invalidate all active sessions
  user.refreshTokens = [];
  user.currentSessions = [];
  await user.save();

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "password_reset_completed",
    targetType: "User",
    targetId: user._id
  });

  res.status(200).json(new ApiResponse(200, null, "Password reset successful. Please log in."));
});

module.exports = {
  register,
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
  forgotPassword,
  resetPassword
};
