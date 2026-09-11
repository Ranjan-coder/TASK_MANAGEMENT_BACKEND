const Comment = require("../models/Comment");
const Task = require("../models/Task");
const Notification = require("../models/Notification");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const { sanitizeRichText } = require("../utils/sanitizeHtml");
const { getIO } = require("../sockets");

const getCommentsByTask = asyncHandler(async (req, res) => {
  const comments = await Comment.find({ task: req.params.taskId })
    .populate("author", "name email avatarUrl designation")
    .populate("attachments")
    .sort({ createdAt: 1 });

  res.status(200).json(new ApiResponse(200, comments, "Comments fetched"));
});

const addComment = asyncHandler(async (req, res) => {
  const { text, mentions, attachments } = req.body;
  const taskId = req.params.taskId;

  const sanitizedText = sanitizeRichText(text);

  const comment = await Comment.create({
    task: taskId,
    author: req.user._id,
    text: sanitizedText,
    mentions: mentions || [],
    attachments: attachments || []
  });

  const task = await Task.findById(taskId);
  if (task) {
    task.activityLog.push({
      action: "commented",
      performedBy: req.user._id,
      meta: { commentId: comment._id }
    });
    await task.save();
  }

  const populatedComment = await Comment.findById(comment._id)
    .populate("author", "name email avatarUrl designation")
    .populate("attachments");

  // Broadcast comment in socket room
  const io = getIO();
  if (io) {
    io.to(`task:${taskId}`).emit("comment:new", populatedComment);
  }

  // Send notifications to mentioned users
  const notifiedUserIds = new Set();
  notifiedUserIds.add(req.user._id.toString());

  if (mentions && mentions.length > 0) {
    for (const mentionedUserId of mentions) {
      const mId = mentionedUserId.toString();
      if (!notifiedUserIds.has(mId)) {
        notifiedUserIds.add(mId);
        const notif = await Notification.create({
          recipient: mentionedUserId,
          sender: req.user._id,
          type: "mentioned",
          title: "You were mentioned in a comment",
          message: `${req.user.name} mentioned you on task: "${task?.title || "Task"}"`,
          relatedTask: taskId,
          relatedComment: comment._id
        });
        if (io) io.to(`user:${mId}`).emit("notification:new", notif);
      }
    }
  }

  // Send notification to task creator (assignedBy)
  if (task?.assignedBy) {
    const creatorId = task.assignedBy.toString();
    if (!notifiedUserIds.has(creatorId)) {
      notifiedUserIds.add(creatorId);
      const notif = await Notification.create({
        recipient: task.assignedBy,
        sender: req.user._id,
        type: "comment_added",
        title: "New Comment on Your Task",
        message: `${req.user.name} commented on "${task.title}": "${sanitizedText.slice(0, 100)}${sanitizedText.length > 100 ? "..." : ""}"`,
        relatedTask: taskId,
        relatedComment: comment._id
      });
      if (io) io.to(`user:${creatorId}`).emit("notification:new", notif);
    }
  }

  // Send notification to task assignees (assignedTo)
  if (task?.assignedTo && task.assignedTo.length > 0) {
    for (const assigneeId of task.assignedTo) {
      const aId = assigneeId.toString();
      if (!notifiedUserIds.has(aId)) {
        notifiedUserIds.add(aId);
        const notif = await Notification.create({
          recipient: assigneeId,
          sender: req.user._id,
          type: "comment_added",
          title: "New Comment on Task",
          message: `${req.user.name} commented on task "${task.title}"`,
          relatedTask: taskId,
          relatedComment: comment._id
        });
        if (io) io.to(`user:${aId}`).emit("notification:new", notif);
      }
    }
  }

  res.status(201).json(new ApiResponse(201, populatedComment, "Comment added"));
});

const updateComment = asyncHandler(async (req, res) => {
  const comment = req.comment; // from verifyCommentOwnership
  const { text } = req.body;

  comment.editHistory.push({
    text: comment.text,
    editedAt: new Date()
  });

  comment.text = sanitizeRichText(text);
  comment.isEdited = true;
  await comment.save();

  const updatedComment = await Comment.findById(comment._id).populate(
    "author",
    "name email avatarUrl designation"
  );

  res.status(200).json(new ApiResponse(200, updatedComment, "Comment updated"));
});

const deleteComment = asyncHandler(async (req, res) => {
  const comment = req.comment; // from verifyCommentOwnership
  await Comment.findByIdAndDelete(comment._id);

  res.status(200).json(new ApiResponse(200, null, "Comment deleted"));
});

module.exports = {
  getCommentsByTask,
  addComment,
  updateComment,
  deleteComment
};
