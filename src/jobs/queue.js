const { Queue } = require("bullmq");
const config = require("../config/env");
const logger = require("../utils/logger");
const { checkRedisAvailability } = require("../utils/redisCheck");

let emailQueue = null;

const initEmailQueue = async () => {
  const isAvailable = await checkRedisAvailability();
  if (!isAvailable) {
    logger.warn("[EmailQueue] Redis not reachable — fallback to direct synchronous email delivery.");
    return;
  }

  try {
    const connection = {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    };
    emailQueue = new Queue("emailQueue", { connection });
    logger.info("[EmailQueue] BullMQ emailQueue initialized");
  } catch (error) {
    logger.warn(`BullMQ Queue initialization skipped: ${error.message}`);
  }
};

initEmailQueue();

const addEmailJob = async (emailData) => {
  if (emailQueue) {
    try {
      await emailQueue.add("sendEmail", emailData);
      return;
    } catch (err) {
      logger.warn(`Failed to push to email queue, falling back to direct send: ${err.message}`);
    }
  }

  // Fallback sync execution
  const { sendEmail } = require("../services/email.service");
  await sendEmail(emailData);
};

module.exports = { emailQueue, addEmailJob };
