const config = require("../config/env");
const ApiError = require("../utils/ApiError");

/**
 * CSRF defence in depth for cookie sign-in. Sign-in cookies are SameSite, but
 * we also refuse any state-changing request whose Origin (or Referer) is a
 * different site. Requests without either header (curl, server-to-server,
 * tests) carry no browser cookies by accident, so they're allowed through to
 * the normal authentication.
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const allowed = new Set(
  [config.clientUrl, ...(process.env.EXTRA_ALLOWED_ORIGINS || "").split(",")]
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
);

const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
};

const originCheck = (req, res, next) => {
  if (SAFE.has(req.method)) return next();
  const origin = req.headers.origin;
  const source = origin && origin !== "null" ? originOf(origin) : req.headers.referer ? originOf(req.headers.referer) : origin === "null" ? "null" : null;
  if (source === null) return next();
  if (allowed.has(source)) return next();
  return next(new ApiError(403, "Request blocked: it didn't come from the Bonito app.", [{ code: "BAD_ORIGIN" }]));
};

module.exports = originCheck;
module.exports._allowed = allowed;
