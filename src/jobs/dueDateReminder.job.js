const { Queue, Worker } = require("bullmq");
const config = require("../config/env");
const logger = require("../utils/logger");
const { checkRedisAvailability } = require("../utils/redisCheck");

/**
 * Due-date reminder job — runs every hour via BullMQ repeatable job.
 * Scans tasks due within the next 24 hours and creates reminder notifications + queues emails.
 */
let reminderQueue = null;

const initDueDateReminder = async () => {
  const isAvailable = await checkRedisAvailability();
  if (!isAvailable) {
    logger.warn("[DueDateReminder] Redis not reachable — due-date background reminders disabled. Start Redis to enable.");
    return;
  }

  try {
    const connection = {
      url: config.redisUrl,
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    };
    reminderQueue = new Queue("dueDateReminderQueue", { connection });

    // Schedule a repeatable job every hour
    await reminderQueue.add(
      "checkDueDates",
      {},
      {
        repeat: { every: 60 * 60 * 1000 }, // every 1 hour
        jobId: "due-date-check" // stable ID prevents duplicate jobs on restart
      }
    );

    const reminderWorker = new Worker(
      "dueDateReminderQueue",
      async () => {
        // Import lazily to avoid circular dependency issues at startup
        const Task = require("../models/Task");
        const Notification = require("../models/Notification");
        const { addEmailJob } = require("./queue");
        const { getIO } = require("../sockets");

        const now = new Date();
        const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const tasksDueSoon = await Task.find({
          isArchived: false,
          status: { $nin: ["completed", "cancelled"] },
          dueDate: { $gte: now, $lte: in24h }
        }).populate("assignedTo", "name email");

        logger.info(`[DueDateReminder] Found ${tasksDueSoon.length} tasks due within 24h`);

        const io = getIO();

        for (const task of tasksDueSoon) {
          for (const assignee of task.assignedTo) {
            // Check if we already sent a reminder today (prevent duplicates)
            const alreadyNotified = await Notification.findOne({
              recipient: assignee._id,
              relatedTask: task._id,
              type: "due_date_reminder",
              createdAt: { $gte: new Date(now.toDateString()) }
            });

            if (alreadyNotified) continue;

            const notif = await Notification.create({
              recipient: assignee._id,
              type: "due_date_reminder",
              title: "Task Due Soon",
              message: `Task "${task.title}" is due within 24 hours.`,
              relatedTask: task._id
            });

            if (io) {
              io.to(`user:${assignee._id}`).emit("notification:new", notif);
            }

            await addEmailJob({
              to: assignee.email,
              subject: `Reminder: Task "${task.title}" is due soon`,
              html: `
                <p>Hi ${assignee.name},</p>
                <p>This is a reminder that the task <strong>${task.title}</strong> is due within 24 hours.</p>
                <p>Due date: <strong>${task.dueDate.toLocaleDateString()}</strong></p>
                <p>Please log in to update its status.</p>
              `
            });
          }
        }
      },
      { connection }
    );

    reminderWorker.on("completed", () => {
      logger.info("[DueDateReminder] Check completed");
    });

    reminderWorker.on("failed", (job, err) => {
      logger.error(`[DueDateReminder] Job failed: ${err.message}`);
    });

    logger.info("[DueDateReminder] Due-date reminder job scheduled (every hour)");
  } catch (error) {
    logger.warn(`[DueDateReminder] Initialization failed: ${error.message}`);
  }
};

initDueDateReminder();

module.exports = { reminderQueue };
