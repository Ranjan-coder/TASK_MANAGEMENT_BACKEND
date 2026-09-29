const logger = require("../utils/logger");

/**
 * Every-minute reply-timer monitor. Runs on MongoDB (not Redis/BullMQ), so the
 * timers keep working when Redis is down. Safe on several servers at once:
 * every step is claimed atomically in sla.service.
 */
const INTERVAL_MS = 60 * 1000;
let timer = null;
let running = false;

const tick = async () => {
  if (running) return; // a slow run is still going
  running = true;
  try {
    const { processDue } = require("../services/sla.service");
    const count = await processDue();
    if (count) logger.info(`[SlaMonitor] processed ${count} waiting chat(s)`);
    const alerts = await require("../services/offlineAlerts.service").processDue();
    if (alerts) logger.info(`[SlaMonitor] processed ${alerts} offline alert(s)`);
    await require("../services/privacy.service").runRetentionIfDue();
    const reminders = await require("../services/payments.service").runReminders();
    if (reminders) logger.info(`[SlaMonitor] sent ${reminders} payment reminder(s)`);
  } catch (err) {
    logger.error(`[SlaMonitor] run failed: ${err.message}`);
  } finally {
    running = false;
  }
};

const startSlaMonitor = () => {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  logger.info("[SlaMonitor] reply timers active (every minute)");
};

const stopSlaMonitor = () => {
  clearInterval(timer);
  timer = null;
};

module.exports = { startSlaMonitor, stopSlaMonitor, tick };
