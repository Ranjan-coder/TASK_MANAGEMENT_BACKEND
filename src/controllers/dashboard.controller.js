const Task = require("../models/Task");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

/**
 * GET /api/v1/dashboard/summary
 * Role-scoped task counts (status, priority breakdowns)
 */
const getDashboardSummary = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === "user") {
    filter.assignedTo = req.user._id;
  }

  const [statusBreakdown, priorityBreakdown, overdueTasks, recentTasks] =
    await Promise.all([
      Task.aggregate([
        { $match: { ...filter, isArchived: false } },
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]),
      Task.aggregate([
        { $match: { ...filter, isArchived: false } },
        { $group: { _id: "$priority", count: { $sum: 1 } } }
      ]),
      Task.countDocuments({
        ...filter,
        isArchived: false,
        dueDate: { $lt: new Date() },
        status: { $nin: ["completed", "cancelled"] }
      }),
      Task.find({ ...filter, isArchived: false })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("assignedTo", "name avatarUrl")
        .populate("assignedBy", "name avatarUrl")
        .select("title status priority dueDate assignedTo assignedBy")
    ]);

  const statusMap = statusBreakdown.reduce((acc, item) => {
    acc[item._id] = item.count;
    return acc;
  }, {});

  const priorityMap = priorityBreakdown.reduce((acc, item) => {
    acc[item._id] = item.count;
    return acc;
  }, {});

  res.status(200).json(
    new ApiResponse(200, {
      statusBreakdown: statusMap,
      priorityBreakdown: priorityMap,
      overdueTasks,
      recentTasks
    }, "Dashboard summary fetched")
  );
});

/**
 * GET /api/v1/dashboard/team-performance
 * Admin/Super Admin: task completion rates per user
 */
const getTeamPerformance = asyncHandler(async (req, res) => {
  const pipeline = [
    { $match: { isArchived: false } },
    { $unwind: "$assignedTo" },
    {
      $group: {
        _id: "$assignedTo",
        total: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] }
        },
        overdue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $lt: ["$dueDate", new Date()] },
                  { $nin: ["$status", ["completed", "cancelled"]] }
                ]
              },
              1,
              0
            ]
          }
        },
        inProgress: {
          $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] }
        }
      }
    },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user"
      }
    },
    { $unwind: "$user" },
    {
      $project: {
        _id: 0,
        userId: "$_id",
        name: "$user.name",
        email: "$user.email",
        avatarUrl: "$user.avatarUrl",
        department: "$user.department",
        total: 1,
        completed: 1,
        overdue: 1,
        inProgress: 1,
        completionRate: {
          $round: [
            {
              $multiply: [
                { $divide: ["$completed", { $cond: [{ $eq: ["$total", 0] }, 1, "$total"] }] },
                100
              ]
            },
            1
          ]
        }
      }
    },
    { $sort: { completionRate: -1 } }
  ];

  const performance = await Task.aggregate(pipeline);

  res.status(200).json(new ApiResponse(200, performance, "Team performance fetched"));
});

/**
 * GET /api/v1/dashboard/audit-logs
 * Super Admin only: paginated audit log
 */
const getAuditLogs = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.action) filter.action = req.query.action;
  if (req.query.targetType) filter.targetType = req.query.targetType;
  if (req.query.actorId) filter.actor = req.query.actorId;

  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .populate("actor", "name email avatarUrl role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    AuditLog.countDocuments(filter)
  ]);

  res.status(200).json(
    new ApiResponse(200, logs, "Audit logs fetched", {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    })
  );
});

module.exports = {
  getDashboardSummary,
  getTeamPerformance,
  getAuditLogs
};
