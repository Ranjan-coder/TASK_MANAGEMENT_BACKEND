const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const config = require("../config/env");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");

const generateTokens = (user) => {
  const accessToken = jwt.sign(
    {
      userId: user._id,
      role: user.role,
      tokenVersion: user.tokenVersion
    },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiry }
  );

  const refreshToken = jwt.sign(
    {
      userId: user._id,
      tokenVersion: user.tokenVersion
    },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiry }
  );

  return { accessToken, refreshToken };
};

const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

const setTokenCookies = (res, accessToken, refreshToken) => {
  const isProd = config.env === "production";

  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "strict" : "lax",
    domain: isProd ? config.cookieDomain : undefined,
    maxAge: 15 * 60 * 1000 // 15 mins
  });

  if (refreshToken) {
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "strict" : "lax",
      domain: isProd ? config.cookieDomain : undefined,
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
  }
};

const clearTokenCookies = (res) => {
  const isProd = config.env === "production";
  const options = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "strict" : "lax",
    domain: isProd ? config.cookieDomain : undefined
  };
  res.clearCookie("accessToken", options);
  res.clearCookie("refreshToken", options);
};

module.exports = {
  generateTokens,
  hashToken,
  setTokenCookies,
  clearTokenCookies
};
