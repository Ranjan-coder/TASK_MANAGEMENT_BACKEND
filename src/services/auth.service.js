const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const config = require("../config/env");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { describeDevice } = require("../utils/device");

const MAX_SESSIONS = 20;
const TRUSTED_REFRESH_EXPIRY = config.jwt.refreshExpiry; // default 7d
const UNTRUSTED_REFRESH_EXPIRY = "12h";
const TRUSTED_COOKIE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Access + refresh tokens for one session. `sid` ties both tokens to an entry in
 * user.currentSessions, so removing that entry signs the device out at once.
 */
const generateTokens = (user, { sessionId, trusted = true } = {}) => {
  const accessToken = jwt.sign(
    { userId: user._id, role: user.role, tokenVersion: user.tokenVersion, sid: sessionId },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiry }
  );

  const refreshToken = jwt.sign(
    { userId: user._id, tokenVersion: user.tokenVersion, sid: sessionId, trusted },
    config.jwt.refreshSecret,
    { expiresIn: trusted ? TRUSTED_REFRESH_EXPIRY : UNTRUSTED_REFRESH_EXPIRY }
  );

  return { accessToken, refreshToken };
};

const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

const cookieBase = () => {
  const isProd = config.env === "production";
  return {
    secure: isProd,
    sameSite: isProd ? "strict" : "lax",
    domain: isProd ? config.cookieDomain : undefined
  };
};

/**
 * Untrusted devices get browser-session cookies (gone when the browser closes)
 * instead of 7-day ones.
 */
const setTokenCookies = (res, accessToken, refreshToken, role, { trusted = true } = {}) => {
  const base = cookieBase();
  const persistent = trusted ? { maxAge: TRUSTED_COOKIE_MS } : {};

  // Non-secret routing hint for the Next.js middleware (customer portal vs staff
  // app). Never used for authorization — the API re-reads the role from the DB.
  if (role) {
    res.cookie("role", role, { ...base, httpOnly: false, ...persistent });
  }

  res.cookie("accessToken", accessToken, { ...base, httpOnly: true, maxAge: 15 * 60 * 1000 });

  if (refreshToken) {
    res.cookie("refreshToken", refreshToken, { ...base, httpOnly: true, ...persistent });
  }
};

const clearTokenCookies = (res) => {
  const options = { ...cookieBase(), httpOnly: true };
  res.clearCookie("accessToken", options);
  res.clearCookie("refreshToken", options);
  res.clearCookie("role", { ...options, httpOnly: false });
};

/** Emails + notifies the user when a device they haven't used before signs in. */
const alertNewDevice = async (user, deviceName, ipAddress) => {
  try {
    const { sendNotification } = require("./notification.service");
    await sendNotification({
      recipient: user._id,
      type: "security_alert",
      title: "New sign-in to your account",
      message: `${deviceName} signed in (IP ${ipAddress}). If this wasn't you, sign out that device in Settings → Devices and change your password.`
    });
    const { addEmailJob } = require("../jobs/queue");
    await addEmailJob({
      to: user.email,
      subject: "New sign-in to your Bonito account",
      html: `<p>Hi ${String(user.name).replace(/[<>&"]/g, "")},</p>
<p>Your account was just signed in from <strong>${deviceName}</strong> (IP ${ipAddress}) at ${new Date().toUTCString()}.</p>
<p>If this was you, no action is needed. If not, sign out that device in <em>Settings → Devices</em> and change your password.</p>`
    });
  } catch (err) {
    logger.warn(`New-device alert not sent for ${user._id}: ${err.message}`);
  }
};

/**
 * Creates a session (one refresh token per device), sets cookies.
 * Saves the user document. `alert`: notify if this device type is new.
 */
const issueSession = async (req, res, user, { trusted = true, alert = true } = {}) => {
  const sessionId = crypto.randomUUID();
  const { accessToken, refreshToken } = generateTokens(user, { sessionId, trusted });
  const userAgent = String(req.headers["user-agent"] || "unknown device").slice(0, 300);
  const deviceName = describeDevice(userAgent);
  const ipAddress = req.ip || "unknown";

  user.currentSessions = user.currentSessions || [];
  const isNewDevice = user.currentSessions.length > 0 && !user.currentSessions.some((s) => s.deviceName === deviceName);

  user.currentSessions.push({
    sessionId,
    device: userAgent,
    deviceName,
    ipAddress,
    refreshTokenHash: hashToken(refreshToken),
    trusted,
    lastActive: new Date(),
    createdAt: new Date()
  });
  // Keep the newest sessions only
  if (user.currentSessions.length > MAX_SESSIONS) {
    user.currentSessions = user.currentSessions.slice(-MAX_SESSIONS);
  }
  user.lastLogin = new Date();
  await user.save();

  setTokenCookies(res, accessToken, refreshToken, user.role, { trusted });
  if (alert && isNewDevice) alertNewDevice(user, deviceName, ipAddress);
  return { accessToken, sessionId };
};

/**
 * Rotates the refresh token of an existing session. Presenting an old
 * (already rotated) refresh token means it was copied: the session is ended.
 */
const rotateSession = async (res, user, decoded, presentedToken) => {
  const session = user.currentSessions.find((s) => s.sessionId === decoded.sid);
  if (!session) throw new ApiError(401, "This device has been signed out.", [{ code: "DEVICE_SIGNED_OUT" }]);

  if (session.refreshTokenHash !== hashToken(presentedToken)) {
    user.currentSessions = user.currentSessions.filter((s) => s.sessionId !== decoded.sid);
    await user.save();
    logger.warn(`Refresh token reuse detected for user ${user._id}; session ${decoded.sid} ended`);
    throw new ApiError(401, "Session ended for your security. Please sign in again.", [{ code: "DEVICE_SIGNED_OUT" }]);
  }

  const trusted = decoded.trusted !== false;
  const { accessToken, refreshToken } = generateTokens(user, { sessionId: session.sessionId, trusted });
  session.refreshTokenHash = hashToken(refreshToken);
  session.lastActive = new Date();
  await user.save();

  setTokenCookies(res, accessToken, refreshToken, user.role, { trusted });
  return { accessToken };
};

/** Session list safe to send to the client. */
const describeSessions = (user, currentSessionId) =>
  (user.currentSessions || [])
    .map((s) => ({
      sessionId: s.sessionId,
      deviceName: s.deviceName || describeDevice(s.device),
      ipAddress: s.ipAddress,
      trusted: s.trusted !== false,
      lastActive: s.lastActive,
      createdAt: s.createdAt,
      current: s.sessionId === currentSessionId
    }))
    .sort((a, b) => (b.current - a.current) || new Date(b.lastActive) - new Date(a.lastActive));

// Short-lived "step" tokens (e.g. phone verification). They carry a `stage`
// claim, which authMiddleware refuses, so they can never act as access tokens.
const signStepToken = (userId, stage, expiresIn = "15m", extra = {}) =>
  jwt.sign({ ...extra, userId, stage }, config.jwt.accessSecret, { expiresIn });

const verifyStepToken = (token, stage) => {
  try {
    const decoded = jwt.verify(String(token || ""), config.jwt.accessSecret);
    if (decoded.stage !== stage) throw new Error("wrong stage");
    return decoded;
  } catch {
    throw new ApiError(401, "Your verification session has expired. Please sign in again.", [
      { code: "STEP_TOKEN_INVALID" }
    ]);
  }
};

module.exports = {
  generateTokens,
  hashToken,
  setTokenCookies,
  clearTokenCookies,
  issueSession,
  rotateSession,
  describeSessions,
  signStepToken,
  verifyStepToken
};
