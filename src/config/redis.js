const Redis = require("ioredis");
const config = require("./env");
const logger = require("../utils/logger");

let redisClient = null;

if (config.redisUrl) {
  try {
    redisClient = new Redis(config.redisUrl, {
      // Callers check status === "ready" before every command; when Redis is down
      // commands must fail at once instead of queueing and stalling requests.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      lazyConnect: true,
      // Keep retrying with backoff (max 30 s) so the app picks Redis back up after an outage.
      retryStrategy(times) {
        return Math.min(times * 500, 30000);
      }
    });

    // lazyConnect avoids crashing at require time; connect explicitly so the
    // client actually reaches "ready" (nothing else would ever trigger it).
    if (config.env !== "test") redisClient.connect().catch(() => {});

    redisClient.on("connect", () => {
      logger.info("Redis Connected successfully");
    });

    redisClient.on("error", (err) => {
      // Suppress spammy connection errors when Redis is not running locally in dev
      if (err.code !== "ECONNREFUSED") {
        logger.error(`Redis Error: ${err.message}`);
      }
    });
  } catch (error) {
    logger.warn(`Redis initialization failed: ${error.message}`);
  }
}

module.exports = redisClient;
