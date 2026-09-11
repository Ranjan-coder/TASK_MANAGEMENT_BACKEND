const jwt = require("jsonwebtoken");
const config = require("../config/env");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

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

  const user = await User.findById(decoded.userId).select("+tokenVersion");
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

  req.user = user;
  next();
});

module.exports = authMiddleware;
