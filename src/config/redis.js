const Redis = require("ioredis");
const config = require("./env");
const logger = require("../utils/logger");

let redisClient = null;

if (config.redisUrl) {
  try {
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 3) {
          return null; // Stop retrying if Redis is down
        }
        return Math.min(times * 100, 1000);
      }
    });

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
