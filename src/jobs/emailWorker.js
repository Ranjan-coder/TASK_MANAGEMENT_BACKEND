const { Worker } = require("bullmq");
const config = require("../config/env");
const logger = require("../utils/logger");
const { sendEmail } = require("../services/email.service");
const { checkRedisAvailability } = require("../utils/redisCheck");

/**
 * Standalone BullMQ email worker.
 * Processes jobs from the "emailQueue" — runs in the same process but
 * can easily be moved to a separate worker process for scale.
 */
let emailWorker = null;

const initEmailWorker = async () => {
  const isAvailable = await checkRedisAvailability();
  if (!isAvailable) {
    logger.warn("[EmailWorker] Redis not reachable — email worker disabled. Start Redis to enable background email processing.");
    return;
  }

  try {
    const connection = {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    };

    emailWorker = new Worker(
      "emailQueue",
      async (job) => {
        logger.info(`[EmailWorker] Processing job ${job.id} — to: ${job.data.to}`);
        await sendEmail(job.data);
        logger.info(`[EmailWorker] Job ${job.id} completed`);
      },
      {
        connection,
        concurrency: 5, // process up to 5 emails in parallel
        limiter: {
          max: 100,        // max 100 jobs per duration window
          duration: 60000  // per minute
        }
      }
    );

    emailWorker.on("completed", (job) => {
      logger.info(`[EmailWorker] Job ${job.id} succeeded`);
    });

    emailWorker.on("failed", (job, err) => {
      logger.error(`[EmailWorker] Job ${job?.id} failed: ${err.message}`);
    });

    emailWorker.on("error", (err) => {
      logger.error(`[EmailWorker] Worker error: ${err?.message || String(err)}`);
    });

    logger.info("[EmailWorker] Email worker initialized and listening");
  } catch (error) {
    logger.warn(`[EmailWorker] Failed to initialize: ${error.message}`);
  }
};

initEmailWorker();

module.exports = { emailWorker };
