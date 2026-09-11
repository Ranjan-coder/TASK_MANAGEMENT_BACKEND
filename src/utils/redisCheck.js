const Redis = require("ioredis");
const config = require("../config/env");

let isRedisAvailableCache = null;

const checkRedisAvailability = async () => {
  if (isRedisAvailableCache !== null) {
    return isRedisAvailableCache;
  }

  if (!config.redisUrl) {
    isRedisAvailableCache = false;
    return false;
  }

  const probe = new Redis(config.redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1500,
    lazyConnect: true
  });

  // Attach error handler to prevent unhandled EventEmitter error spam
  probe.on("error", () => {});

  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    isRedisAvailableCache = true;
    return true;
  } catch {
    isRedisAvailableCache = false;
    try {
      probe.disconnect();
    } catch (_) {}
    return false;
  }
};

module.exports = { checkRedisAvailability };
