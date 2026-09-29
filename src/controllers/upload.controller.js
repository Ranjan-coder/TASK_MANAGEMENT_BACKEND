const crypto = require("crypto");
const Attachment = require("../models/Attachment");
const Task = require("../models/Task");
const Comment = require("../models/Comment");
const Notification = require("../models/Notification");
const cloudinary = require("../config/cloudinary");
const { validateSafeUrl } = require("../utils/ssrfGuard");
const { getIO } = require("../sockets");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const mongoose = require("mongoose");
const { stripImageMetadata } = require("../utils/imageMetadata");

/** The task a task/comment attachment belongs to, if this user may see it (same rule as verifyTaskAccess "view"). */
const accessibleTask = async (user, entityType, entityId) => {
  if (!mongoose.isValidObjectId(entityId)) throw new ApiError(400, "Invalid entityId");
  let task = null;
  if (entityType === "task") task = await Task.findById(entityId);
  else if (entityType === "comment") {
    const comment = await Comment.findById(entityId).select("task");
    task = comment ? await Task.findById(comment.task) : null;
  }
  if (!task) throw new ApiError(404, "Task not found");
  const uid = String(user._id);
  const allowed =
    ["admin", "superadmin"].includes(user.role) ||
    String(task.assignedBy) === uid ||
    task.assignedTo.some((u) => String(u) === uid) ||
    (task.watchers || []).some((u) => String(u) === uid);
  if (!allowed) throw new ApiError(403, "You don't have access to this task");
  return task;
};

// Files are typed by their actual bytes; the name and the browser's claimed type are not trusted
const DETECTED = {
  "application/pdf": { fileType: "pdf", ext: "pdf" },
  "image/jpeg": { fileType: "image", ext: "jpg" },
  "image/png": { fileType: "image", ext: "png" },
  "image/webp": { fileType: "image", ext: "webp" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { fileType: "doc", ext: "docx" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { fileType: "xls", ext: "xlsx" },
  // Legacy .doc / .xls are OLE compound files; the name decides which
  "application/x-cfb": { fileType: null, ext: null }
};

const detectFile = async (buffer, originalName) => {
  const { fileTypeFromBuffer } = await import("file-type");
  const found = await fileTypeFromBuffer(buffer);
  const known = found && DETECTED[found.mime];
  if (!known) throw new ApiError(400, "Unsupported file. Allowed: PDF, Word, Excel, JPG, PNG, WebP.");
  if (found.mime === "application/x-cfb") {
    const ext = String(originalName).split(".").pop().toLowerCase();
    if (ext === "doc") return { mime: "application/msword", fileType: "doc", ext };
    if (ext === "xls") return { mime: "application/vnd.ms-excel", fileType: "xls", ext };
    throw new ApiError(400, "Unsupported file. Allowed: PDF, Word, Excel, JPG, PNG, WebP.");
  }
  return { mime: found.mime, ...known };
};

const safeName = (name) => String(name || "file").replace(/[\u0000-\u001F\u007F<>"'`\\/]/g, "_").slice(0, 150);

const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, "No file uploaded");
  }

  const { entityType, entityId } = req.body;
  if (!["task", "comment"].includes(entityType) || !entityId) {
    throw new ApiError(400, "Valid entityType (task/comment) and entityId are required");
  }
  await accessibleTask(req.user, entityType, entityId);

  const detected = await detectFile(req.file.buffer, req.file.originalname);
  const { ext, fileType } = detected;
  if (fileType === "image") req.file.buffer = stripImageMetadata(req.file.buffer, detected.mime); // drop GPS/EXIF

  let secureUrl = "";
  let publicId = "";

  if (cloudinary.config().cloud_name) {
    try {
      // Stream buffer to Cloudinary
      const uploadStream = () =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: `task_manager/${entityType}s`,
              resource_type: fileType === "image" ? "image" : "raw",
              // Private: only reachable through the short-lived links the API hands to people on the task
              type: "private",
              public_id: `${Date.now()}_${crypto.randomBytes(6).toString("hex")}`
            },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          );
          stream.end(req.file.buffer);
        });

      const result = await uploadStream();
      secureUrl = result.secure_url;
      publicId = result.public_id;
    } catch (cloudErr) {
      console.warn(`[Cloudinary Warning] Upload failed (${cloudErr.message}), falling back to direct data.`);
      if (fileType === "image") {
        const base64 = req.file.buffer.toString("base64");
        secureUrl = `data:${detected.mime};base64,${base64}`;
      } else {
        secureUrl = `https://storage.placeholder.com/mock-upload-${Date.now()}.${ext}`;
      }
      publicId = `local_${Date.now()}`;
    }
  } else {
    // Local / Dev Fallback Mock URL
    if (fileType === "image") {
      const base64 = req.file.buffer.toString("base64");
      secureUrl = `data:${detected.mime};base64,${base64}`;
    } else {
      secureUrl = `https://storage.placeholder.com/mock-upload-${Date.now()}.${ext}`;
    }
    publicId = `local_${Date.now()}`;
  }

  const attachment = await Attachment.create({
    fileName: `${crypto.randomUUID()}.${ext}`,
    originalName: safeName(req.file.originalname),
    fileType,
    mimeType: detected.mime,
    fileSize: req.file.size,
    url: secureUrl,
    publicId,
    delivery: publicId.startsWith("local_") ? "public" : "private",
    uploadedBy: req.user._id,
    relatedTo: { entityType, entityId }
  });

  let targetTask = null;
  if (entityType === "task") {
    targetTask = await Task.findByIdAndUpdate(
      entityId,
      {
        $push: {
          attachments: attachment._id,
          activityLog: {
            action: "attachment_added",
            performedBy: req.user._id,
            meta: { attachmentId: attachment._id, fileName: attachment.originalName }
          }
        }
      },
      { new: true }
    );
  } else if (entityType === "comment") {
    const comment = await Comment.findByIdAndUpdate(
      entityId,
      { $push: { attachments: attachment._id } },
      { new: true }
    );
    if (comment?.task) {
      targetTask = await Task.findById(comment.task);
    }
  }

  // Send real-time and stored notification to the task creator & assignees
  if (targetTask) {
    const io = getIO();
    const notifiedUserIds = new Set();
    notifiedUserIds.add(req.user._id.toString());

    // 1. Notify the task creator (assignedBy)
    if (targetTask.assignedBy) {
      const creatorId = targetTask.assignedBy.toString();
      if (!notifiedUserIds.has(creatorId)) {
        notifiedUserIds.add(creatorId);
        const notif = await Notification.create({
          recipient: targetTask.assignedBy,
          sender: req.user._id,
          type: "attachment_added",
          title: "New Attachment Added",
          message: `${req.user.name} uploaded a file "${attachment.originalName}" to your task "${targetTask.title}"`,
          relatedTask: targetTask._id
        });
        if (io) io.to(`user:${creatorId}`).emit("notification:new", notif);
      }
    }

    // 2. Notify assignees (assignedTo)
    if (targetTask.assignedTo && targetTask.assignedTo.length > 0) {
      for (const assigneeId of targetTask.assignedTo) {
        const aId = assigneeId.toString();
        if (!notifiedUserIds.has(aId)) {
          notifiedUserIds.add(aId);
          const notif = await Notification.create({
            recipient: assigneeId,
            sender: req.user._id,
            type: "attachment_added",
            title: "New Attachment on Task",
            message: `${req.user.name} uploaded a file "${attachment.originalName}" to task "${targetTask.title}"`,
            relatedTask: targetTask._id
          });
          if (io) io.to(`user:${aId}`).emit("notification:new", notif);
        }
      }
    }
  }

  res.status(201).json(new ApiResponse(201, attachment, "File uploaded successfully"));
});

const attachExternalLink = asyncHandler(async (req, res) => {
  const { url, title, entityType, entityId } = req.body;

  if (!url || !entityType || !entityId) {
    throw new ApiError(400, "URL, entityType, and entityId are required");
  }

  if (!["task", "comment"].includes(entityType)) throw new ApiError(400, "Valid entityType (task/comment) is required");
  await accessibleTask(req.user, entityType, entityId);

  try {
    await validateSafeUrl(url);
  } catch (err) {
    throw new ApiError(400, `Invalid link or SSRF violation: ${err.message}`);
  }

  const attachment = await Attachment.create({
    fileName: title || url,
    originalName: title || url,
    fileType: "link",
    mimeType: "text/uri-list",
    fileSize: 0,
    url,
    uploadedBy: req.user._id,
    relatedTo: { entityType, entityId }
  });

  let targetTask = null;
  if (entityType === "task") {
    targetTask = await Task.findByIdAndUpdate(
      entityId,
      {
        $push: {
          attachments: attachment._id,
          activityLog: {
            action: "attachment_added",
            performedBy: req.user._id,
            meta: { attachmentId: attachment._id, url: attachment.url, title: attachment.fileName }
          }
        }
      },
      { new: true }
    );
  } else if (entityType === "comment") {
    const comment = await Comment.findByIdAndUpdate(
      entityId,
      { $push: { attachments: attachment._id } },
      { new: true }
    );
    if (comment?.task) {
      targetTask = await Task.findById(comment.task);
    }
  }

  // Send real-time and stored notification to the task creator & assignees
  if (targetTask) {
    const io = getIO();
    const notifiedUserIds = new Set();
    notifiedUserIds.add(req.user._id.toString());

    // 1. Notify the task creator (assignedBy)
    if (targetTask.assignedBy) {
      const creatorId = targetTask.assignedBy.toString();
      if (!notifiedUserIds.has(creatorId)) {
        notifiedUserIds.add(creatorId);
        const notif = await Notification.create({
          recipient: targetTask.assignedBy,
          sender: req.user._id,
          type: "link_added",
          title: "New Link Attached",
          message: `${req.user.name} attached a link "${title || url}" to your task "${targetTask.title}"`,
          relatedTask: targetTask._id
        });
        if (io) io.to(`user:${creatorId}`).emit("notification:new", notif);
      }
    }

    // 2. Notify assignees (assignedTo)
    if (targetTask.assignedTo && targetTask.assignedTo.length > 0) {
      for (const assigneeId of targetTask.assignedTo) {
        const aId = assigneeId.toString();
        if (!notifiedUserIds.has(aId)) {
          notifiedUserIds.add(aId);
          const notif = await Notification.create({
            recipient: assigneeId,
            sender: req.user._id,
            type: "link_added",
            title: "New Link on Task",
            message: `${req.user.name} attached a link "${title || url}" to task "${targetTask.title}"`,
            relatedTask: targetTask._id
          });
          if (io) io.to(`user:${aId}`).emit("notification:new", notif);
        }
      }
    }
  }

  res.status(201).json(new ApiResponse(201, attachment, "Link attached successfully"));
});

const deleteAttachment = asyncHandler(async (req, res) => {
  const attachment = await Attachment.findById(req.params.id);
  if (!attachment) {
    throw new ApiError(404, "Attachment not found");
  }

  const isOwner = attachment.uploadedBy.toString() === req.user._id.toString();
  const isAdmin = req.user.role === "admin" || req.user.role === "superadmin";

  if (!isOwner && !isAdmin) {
    throw new ApiError(403, "You do not have permission to delete this attachment");
  }

  if (attachment.publicId && cloudinary.config().cloud_name) {
    try {
      await cloudinary.uploader.destroy(attachment.publicId, {
        resource_type: attachment.fileType === "image" ? "image" : "raw",
        ...(attachment.delivery === "private" && { type: "private" })
      });
    } catch {
      // Continue DB cleanup
    }
  }

  await Attachment.findByIdAndDelete(attachment._id);
  res.status(200).json(new ApiResponse(200, null, "Attachment deleted"));
});

const getAttachment = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, "Invalid id");
  const attachment = await Attachment.findById(req.params.id);
  if (!attachment) {
    throw new ApiError(404, "Attachment not found");
  }
  const { entityType, entityId } = attachment.relatedTo || {};
  try {
    await accessibleTask(req.user, entityType, entityId);
  } catch {
    throw new ApiError(404, "Attachment not found");
  }
  res.status(200).json(new ApiResponse(200, attachment, "Attachment fetched"));
});

const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, "No image file uploaded");
  }

  const { fileTypeFromBuffer } = await import("file-type");
  const found = await fileTypeFromBuffer(req.file.buffer);
  if (!["image/jpeg", "image/png", "image/webp"].includes(found?.mime)) {
    throw new ApiError(400, "Please upload a JPG, PNG or WebP image");
  }
  if (req.file.size > 5 * 1024 * 1024) throw new ApiError(400, "Profile photos must be 5 MB or smaller");
  req.file.buffer = stripImageMetadata(req.file.buffer, found.mime);
  const avatarMime = found.mime;

  let avatarUrl = "";
  const User = require("../models/User");

  // Attempt Cloudinary upload if configured, otherwise fallback to Data URI
  if (cloudinary.config().cloud_name) {
    try {
      const uploadStream = () =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: "task_manager/avatars",
              transformation: [{ width: 300, height: 300, crop: "fill", gravity: "face" }],
              public_id: `avatar_${req.user._id}_${Date.now()}`
            },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          );
          stream.end(req.file.buffer);
        });

      const result = await uploadStream();
      avatarUrl = result.secure_url;
    } catch (cloudErr) {
      console.warn(`[Cloudinary Warning] Upload failed (${cloudErr.message}), falling back to direct image data.`);
      const base64 = req.file.buffer.toString("base64");
      avatarUrl = `data:${avatarMime};base64,${base64}`;
    }
  } else {
    // Direct Data URI for instant local/dev support without Cloudinary
    const base64 = req.file.buffer.toString("base64");
    avatarUrl = `data:${avatarMime};base64,${base64}`;
  }

  const updatedUser = await User.findByIdAndUpdate(
    req.user._id,
    { $set: { avatarUrl } },
    { new: true }
  ).select("-refreshTokens");

  res.status(200).json(
    new ApiResponse(200, { avatarUrl, user: updatedUser }, "Profile picture uploaded successfully")
  );
});

module.exports = {
  uploadFile,
  uploadAvatar,
  attachExternalLink,
  getAttachment,
  deleteAttachment
};
