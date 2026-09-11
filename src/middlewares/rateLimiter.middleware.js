const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const redisClient = require("../config/redis");
const ApiError = require("../utils/ApiError");

const createLimiter = ({ windowMs, max, message }) => {
  const options = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      if (req.user && req.user._id) {
        return `user:${req.user._id}`;
      }
      return req.ip || req.headers["x-forwarded-for"] || "unknown-ip";
    },
    handler: (req, res, next) => {
      next(new ApiError(429, message));
    }
  };

  if (redisClient && redisClient.status === "ready") {
    options.store = new RedisStore({
      sendCommand: (...args) => redisClient.call(...args)
    });
  }

  return rateLimit(options);
};

const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts from this IP/account. Please try again in 15 minutes."
});

const apiLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: "Too many requests. Please slow down."
});

const uploadLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Upload rate limit exceeded. Please try again later."
});

module.exports = { authLimiter, apiLimiter, uploadLimiter };
