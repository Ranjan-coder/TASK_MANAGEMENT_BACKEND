const Task = require("../models/Task");
const Comment = require("../models/Comment");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

const verifyTaskAccess = (action = "view") =>
  asyncHandler(async (req, res, next) => {
    const taskId = req.params.id || req.params.taskId;
    if (!taskId) return next(new ApiError(400, "Task ID is required"));

    const task = await Task.findById(taskId);
    if (!task) return next(new ApiError(404, "Task not found"));

    const userId = req.user._id.toString();
    const isSuperAdmin = req.user.role === "superadmin";
    const isAdmin = req.user.role === "admin";
    const isCreator = task.assignedBy.toString() === userId;
    const isAssignee = task.assignedTo.some((u) => u.toString() === userId);
    const isWatcher = task.watchers.some((u) => u.toString() === userId);

    if (action === "view") {
      if (isSuperAdmin || isAdmin || isCreator || isAssignee || isWatcher) {
        req.task = task;
        return next();
      }
    }

    if (action === "edit") {
      if (isSuperAdmin || (isAdmin && isCreator)) {
        req.task = task;
        return next();
      }
    }

    if (action === "status_update") {
      if (isSuperAdmin || isAdmin || isAssignee) {
        req.task = task;
        return next();
      }
    }

    if (action === "delete") {
      if (isSuperAdmin || (isAdmin && isCreator)) {
        req.task = task;
        return next();
      }
    }

    return next(new ApiError(403, "Access denied: Unauthorized task operation"));
  });

const verifyCommentOwnership = asyncHandler(async (req, res, next) => {
  const commentId = req.params.id || req.params.commentId;
  const comment = await Comment.findById(commentId);
  if (!comment) return next(new ApiError(404, "Comment not found"));

  const isSuperAdmin = req.user.role === "superadmin";
  const isAdmin = req.user.role === "admin";
  const isAuthor = comment.author.toString() === req.user._id.toString();

  if (req.method === "DELETE" && (isSuperAdmin || isAdmin || isAuthor)) {
    req.comment = comment;
    return next();
  }

  if ((req.method === "PATCH" || req.method === "PUT") && isAuthor) {
    req.comment = comment;
    return next();
  }

  return next(new ApiError(403, "Access denied: You can only modify your own comments"));
});

module.exports = { verifyTaskAccess, verifyCommentOwnership };
