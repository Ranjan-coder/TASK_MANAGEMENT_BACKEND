const logger = require("../utils/logger");

/**
 * Every-minute reply-timer monitor. Runs on MongoDB (not Redis/BullMQ), so the
 * timers keep working when Redis is down. Safe on several servers at once:
 * every step is claimed atomically in sla.service.
 */
const INTERVAL_MS = 60 * 1000;
let timer = null;
let running = false;
// Seat counters are rebuilt from the people once an hour, so any drift heals
const SEAT_RECOUNT_MS = 60 * 60 * 1000;
let lastSeatRecount = 0;

const tick = async () => {
  if (running) return; // a slow run is still going
  running = true;
  try {
    // Each step runs once per organisation, scoped to it (settings, business hours
    // and data are all per organisation)
    const { forEachOrg } = require("../utils/forEachOrg");
    const { processDue } = require("../services/sla.service");
    const count = await forEachOrg("SlaMonitor", () => processDue(), { module: "chat" });
    if (count) logger.info(`[SlaMonitor] processed ${count} waiting chat(s)`);
    const alerts = await forEachOrg("OfflineAlerts", () => require("../services/offlineAlerts.service").processDue(), { module: "chat" });
    if (alerts) logger.info(`[SlaMonitor] processed ${alerts} offline alert(s)`);
    await forEachOrg("Retention", () => require("../services/privacy.service").runRetentionIfDue());
    const reminders = await forEachOrg("PaymentReminders", () => require("../services/payments.service").runReminders(), { module: "payments" });
    if (reminders) logger.info(`[SlaMonitor] sent ${reminders} payment reminder(s)`);
    // Jobs of packaged modules, only where the organisation has that module
    for (const job of require("../modules").allJobs()) {
      const n = await forEachOrg(job.label, () => job.run(), { module: job.module });
      if (n) logger.info(`[${job.label}] processed ${n}`);
    }
    if (Date.now() - lastSeatRecount > SEAT_RECOUNT_MS) {
      lastSeatRecount = Date.now();
      await forEachOrg("SeatRecount", () => require("../services/moduleAccess.service").recountSeats().then(() => 0));
    }
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
