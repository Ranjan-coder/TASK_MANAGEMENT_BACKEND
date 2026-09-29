const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const redisClient = require("../config/redis");
const ApiError = require("../utils/ApiError");

/**
 * Store that uses Redis whenever it's connected (shared across servers, survives restarts)
 * and falls back to memory while it isn't. Decided per request, because Redis connects
 * after the limiters are created.
 */
class HybridStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.memory = new rateLimit.MemoryStore();
    this.redis = null; // created on first use once Redis is connected (it loads a script on creation)
    this.options = null;
  }
  init(options) {
    this.options = options;
    this.memory.init(options);
  }
  get active() {
    if (!redisClient || redisClient.status !== "ready") return this.memory;
    if (!this.redis) {
      this.redis = new RedisStore({ prefix: `rl:${this.prefix}:`, sendCommand: (...args) => redisClient.call(...args) });
      this.redis.init?.(this.options);
    }
    return this.redis;
  }
  increment(key) {
    return this.active.increment(key);
  }
  decrement(key) {
    return this.active.decrement(key);
  }
  resetKey(key) {
    return this.active.resetKey(key);
  }
  get(key) {
    return this.active.get?.(key);
  }
}

let limiterCount = 0;
const createLimiter = ({ windowMs, max, message, keyGenerator }) => {
  limiterCount += 1;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true, // a Redis hiccup must not take the API down
    store: new HybridStore(`l${limiterCount}`),
    keyGenerator:
      keyGenerator ||
      ((req) => {
        if (req.user && req.user._id) {
          return `user:${req.user._id}`;
        }
        return req.ip || "unknown-ip";
      }),
    handler: (req, res, next) => {
      next(new ApiError(429, message));
    }
  });
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

module.exports = { createLimiter, authLimiter, apiLimiter, uploadLimiter };
