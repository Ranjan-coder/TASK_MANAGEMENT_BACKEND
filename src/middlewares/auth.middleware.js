const jwt = require("jsonwebtoken");
const config = require("../config/env");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { evaluateAccess } = require("./accessPolicy");
const tenant = require("../utils/tenantContext");
const { getOrgStatus, getEntitlements } = require("../services/organisation.service");
const { checkModuleAccess } = require("./moduleGate");
const { isPlatformUser } = require("../services/accountLookup.service");

const authMiddleware = asyncHandler(async (req, res, next) => {
  let token = null;

  if (req.cookies && req.cookies.accessToken) {
    token = req.cookies.accessToken;
  } else if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return next(new ApiError(401, "Authentication token missing or invalid"));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.accessSecret);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return next(new ApiError(401, "Token expired", [{ code: "TOKEN_EXPIRED" }]));
    }
    return next(new ApiError(401, "Invalid access token"));
  }

  // Short-lived step tokens (2FA pending, phone verification) are signed with the
  // same secret but must never work as access tokens.
  if (decoded.stage) {
    return next(new ApiError(401, "Invalid access token"));
  }

  // The account is looked up before its organisation is known
  const user = await tenant.runAsSystem(() => User.findById(decoded.userId).select("+tokenVersion"));
  if (!user) {
    return next(new ApiError(401, "User belonging to this token no longer exists"));
  }

  if (user.status === "suspended" || user.status === "inactive") {
    return next(new ApiError(403, `Account is currently ${user.status}. Access denied.`));
  }

  // Token version check for instant global revocation
  if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
    return next(new ApiError(401, "Session has been revoked. Please log in again."));
  }

  // Every access token belongs to a device session; a removed session
  // (signed out from Settings → Devices, or reuse detected) stops working at once.
  if (!decoded.sid || !(user.currentSessions || []).some((sess) => sess.sessionId === decoded.sid)) {
    return next(new ApiError(401, "This device has been signed out.", [{ code: "DEVICE_SIGNED_OUT" }]));
  }
  req.sessionId = decoded.sid;

  // Deny-by-default role scope, forced password change and privileged-2FA gates
  const access = evaluateAccess({ user, method: req.method, originalUrl: req.originalUrl });
  if (!access.allowed) {
    return next(new ApiError(403, access.message, [{ code: access.code }]));
  }

  // The product owner works at the platform level: scoped to orgId null, so no
  // organisation's data is reachable (module-access-plan.md, M3)
  const platform = isPlatformUser(user);

  // A suspended organisation locks out all of its people at once
  const orgStatus = platform ? "active" : await getOrgStatus(user.orgId);
  if (orgStatus !== "active") {
    return next(new ApiError(403, "Your organisation's access is paused. Contact your administrator.", [{ code: "ORG_SUSPENDED" }]));
  }

  // Module gate: the organisation must have the module this route belongs to
  const { mask: orgMask, customerMask } = platform ? { mask: 0, customerMask: 0 } : await getEntitlements(user.orgId);
  const gate = checkModuleAccess({ user, originalUrl: req.originalUrl, orgMask, customerMask });
  if (!gate.allowed) {
    return next(new ApiError(403, gate.message, [{ code: gate.code, module: gate.module }]));
  }
  req.orgModules = orgMask;
  req.orgCustomerModules = customerMask;

  req.user = user;
  // Everything after this point (routes, services, queries) runs inside the
  // user's organisation; req.tenant lets handlers re-enter it where a stream
  // callback (e.g. multer) loses the async context.
  req.tenant = platform ? { platform: true, orgId: null } : { orgId: user.orgId };
  tenant.runWithStore(req.tenant, () => next());
});

module.exports = authMiddleware;
