const Task = require("../models/Task");
const Notification = require("../models/Notification");
const { getIO } = require("../sockets");
const { sanitizeRichText } = require("../utils/sanitizeHtml");

const createTask = async ({ taskData, creatorId }) => {
  if (taskData.description) {
    taskData.description = sanitizeRichText(taskData.description);
  }

  const task = await Task.create({
    ...taskData,
    assignedBy: creatorId,
    activityLog: [
      {
        action: "created",
        performedBy: creatorId,
        meta: { title: taskData.title }
      }
    ]
  });

  // Emit real-time notification to assignees
  if (task.assignedTo && task.assignedTo.length > 0) {
    const io = getIO();
    for (const assigneeId of task.assignedTo) {
      if (assigneeId.toString() !== creatorId.toString()) {
        const notif = await Notification.create({
          recipient: assigneeId,
          sender: creatorId,
          type: "task_assigned",
          title: "New Task Assigned",
          message: `You have been assigned to: ${task.title}`,
          relatedTask: task._id
        });

        if (io) {
          io.to(`user:${assigneeId}`).emit("notification:new", notif);
        }
      }
    }
  }

  return task;
};

const updateTaskStatus = async ({ task, newStatus, userId }) => {
  const oldStatus = task.status;
  task.status = newStatus;
  if (newStatus === "completed") {
    task.completedAt = new Date();
  }

  task.activityLog.push({
    action: "status_changed",
    performedBy: userId,
    meta: { from: oldStatus, to: newStatus }
  });

  await task.save();

  const io = getIO();
  if (io) {
    io.to(`task:${task._id}`).emit("task:updated", {
      taskId: task._id,
      status: newStatus,
      updatedBy: userId
    });
  }

  return task;
};

module.exports = {
  createTask,
  updateTaskStatus
};
