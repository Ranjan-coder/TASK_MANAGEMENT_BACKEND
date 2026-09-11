const Task = require("../models/Task");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const taskService = require("../services/task.service");
const { recordAuditLog } = require("../services/audit.service");

const getTasks = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const skip = (page - 1) * limit;

  const filter = { isArchived: false };

  // Data Scoping: User only sees tasks assigned to them
  if (req.user.role === "user") {
    filter.assignedTo = req.user._id;
  }

  if (req.query.status) filter.status = req.query.status;
  if (req.query.priority) filter.priority = req.query.priority;
  if (req.query.category) filter.category = req.query.category;
  if (req.query.assignedTo && req.user.role !== "user") {
    filter.assignedTo = req.query.assignedTo;
  }

  if (req.query.search && req.query.search.trim()) {
    const searchRegex = new RegExp(req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { title: searchRegex },
      { description: searchRegex },
      { category: searchRegex },
      { tags: searchRegex }
    ];
  }

  const [tasks, total] = await Promise.all([
    Task.find(filter)
      .populate("assignedTo", "name email avatarUrl designation")
      .populate("assignedBy", "name email avatarUrl")
      .populate("attachments")
      .sort({ dueDate: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Task.countDocuments(filter)
  ]);

  res.status(200).json(
    new ApiResponse(200, tasks, "Tasks fetched successfully", {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    })
  );
});

const getTaskById = asyncHandler(async (req, res) => {
  // req.task populated by verifyTaskAccess middleware
  const task = await Task.findById(req.params.id)
    .populate("assignedTo", "name email avatarUrl department designation")
    .populate("assignedBy", "name email avatarUrl")
    .populate("attachments")
    .populate("activityLog.performedBy", "name avatarUrl");

  res.status(200).json(new ApiResponse(200, task, "Task retrieved"));
});

const createTask = asyncHandler(async (req, res) => {
  const task = await taskService.createTask({
    taskData: req.body,
    creatorId: req.user._id
  });

  await recordAuditLog({
    req,
    action: "task_created",
    targetType: "Task",
    targetId: task._id,
    metadata: { title: task.title }
  });

  const populatedTask = await Task.findById(task._id)
    .populate("assignedTo", "name email avatarUrl")
    .populate("assignedBy", "name email avatarUrl");

  res.status(201).json(new ApiResponse(201, populatedTask, "Task created successfully"));
});

const updateTask = asyncHandler(async (req, res) => {
  const task = req.task; // from verifyTaskAccess
  const allowedUpdates = [
    "title",
    "description",
    "priority",
    "dueDate",
    "startDate",
    "tags",
    "category",
    "assignedTo",
    "watchers"
  ];

  allowedUpdates.forEach((field) => {
    if (req.body[field] !== undefined) {
      task[field] = req.body[field];
    }
  });

  task.activityLog.push({
    action: "edited",
    performedBy: req.user._id,
    meta: { fields: Object.keys(req.body) }
  });

  await task.save();

  res.status(200).json(new ApiResponse(200, task, "Task updated successfully"));
});

const updateTaskStatus = asyncHandler(async (req, res) => {
  const task = req.task; // from verifyTaskAccess
  const { status } = req.body;

  const updatedTask = await taskService.updateTaskStatus({
    task,
    newStatus: status,
    userId: req.user._id
  });

  res.status(200).json(new ApiResponse(200, updatedTask, `Task status updated to ${status}`));
});

const deleteTask = asyncHandler(async (req, res) => {
  const task = req.task;
  task.isArchived = true;
  await task.save();

  await recordAuditLog({
    req,
    action: "task_deleted",
    targetType: "Task",
    targetId: task._id
  });

  res.status(200).json(new ApiResponse(200, null, "Task archived/deleted successfully"));
});

const reassignTask = asyncHandler(async (req, res) => {
  const task = req.task; // from verifyTaskAccess('edit')
  const { assignedTo } = req.body;

  if (!assignedTo || !Array.isArray(assignedTo) || assignedTo.length === 0) {
    throw new ApiError(400, "assignedTo must be a non-empty array of user IDs");
  }

  const previousAssignees = task.assignedTo.map((u) => u.toString());
  task.assignedTo = assignedTo;

  task.activityLog.push({
    action: "reassigned",
    performedBy: req.user._id,
    meta: { from: previousAssignees, to: assignedTo }
  });

  await task.save();

  // Notify newly added assignees
  const { Notification } = require("../models/Notification") || {};
  const NotificationModel = require("../models/Notification");
  const { getIO } = require("../sockets");
  const io = getIO();

  for (const userId of assignedTo) {
    if (!previousAssignees.includes(userId.toString())) {
      const notif = await NotificationModel.create({
        recipient: userId,
        sender: req.user._id,
        type: "task_assigned",
        title: "Task Reassigned to You",
        message: `You have been assigned to task: ${task.title}`,
        relatedTask: task._id
      });
      if (io) io.to(`user:${userId}`).emit("notification:new", notif);
    }
  }

  const populatedTask = await Task.findById(task._id)
    .populate("assignedTo", "name email avatarUrl")
    .populate("assignedBy", "name email avatarUrl");

  res.status(200).json(new ApiResponse(200, populatedTask, "Task reassigned successfully"));
});

const getTaskActivity = asyncHandler(async (req, res) => {
  const task = await Task.findById(req.params.id)
    .select("activityLog title")
    .populate("activityLog.performedBy", "name email avatarUrl");

  if (!task) throw new ApiError(404, "Task not found");

  res.status(200).json(new ApiResponse(200, task.activityLog, "Task activity fetched"));
});

module.exports = {
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  updateTaskStatus,
  reassignTask,
  getTaskActivity,
  deleteTask
};
