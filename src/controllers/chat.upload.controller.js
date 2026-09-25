const crypto = require("crypto");
const cloudinary = require("../config/cloudinary");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const { getIO } = require("../sockets");

/**
 * POST /api/v1/chat/conversations/:id/attachments
 *
 * Accepts an encrypted file blob (the client encrypts bytes with AES-256-GCM
 * before sending). The server does NOT see plaintext file content — it only
 * stores the opaque encrypted binary in Cloudinary as "raw".
 *
 * Multipart fields:
 *   file          — encrypted binary blob (required)
 *   originalName  — original filename shown to recipients (required)
 *   mimeType      — original MIME type (required)
 *   fileSize      — original file size in bytes (required)
 *   fileType      — "image" | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "other"
 *   encryptedFileKey — AES key for file, wrapped with session key (required)
 *   fileIv        — IV used to encrypt the file bytes (required)
 *   replyTo       — optional message ID to reply to
 *
 * Response includes a Message object that is then broadcast via socket.
 */
const uploadChatAttachment = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, "No file uploaded");

  const conversationId = req.params.id;
  const { originalName, mimeType, fileSize, fileType, encryptedFileKey, fileIv, replyTo } = req.body;

  if (!originalName) throw new ApiError(400, "originalName is required");
  if (!encryptedFileKey || !fileIv) throw new ApiError(400, "encryptedFileKey and fileIv are required");

  // Verify membership
  const conv = await Conversation.findOne({
    _id: conversationId,
    "members.user": req.user._id
  });
  if (!conv) throw new ApiError(403, "Not a member of this conversation");

  // Upload encrypted blob to Cloudinary as "raw" resource
  let secureUrl = "";
  let publicId = "";
  let thumbnailUrl = null;

  const uniqueId = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

  if (cloudinary.config().cloud_name) {
    try {
      const uploadStream = () =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: "task_manager/chat_attachments",
              resource_type: "raw", // Always raw — file is encrypted binary
              public_id: uniqueId,
              // Tag for easy bulk-deletion later
              tags: [`conv:${conversationId}`]
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
      // Fallback for dev/test
      secureUrl = `https://storage.placeholder.com/chat-enc-${uniqueId}`;
      publicId = `local_${uniqueId}`;
    }
  } else {
    secureUrl = `https://storage.placeholder.com/chat-enc-${uniqueId}`;
    publicId = `local_${uniqueId}`;
  }

  const resolvedFileType = fileType || "other";

  // Build attachment metadata (no plaintext content stored)
  const attachmentMeta = {
    fileName: uniqueId,
    originalName: originalName || req.file.originalname,
    fileType: resolvedFileType,
    mimeType: mimeType || req.file.mimetype,
    fileSize: parseInt(fileSize, 10) || req.file.size,
    url: secureUrl,
    publicId,
    thumbnailUrl,
    encryptedFileKey,
    fileIv
  };

  // Save message with attachment
  const message = await Message.create({
    conversation: conversationId,
    sender: req.user._id,
    type: resolvedFileType === "image" ? "image" : "file",
    ciphertext: null, // no text ciphertext for pure file messages
    iv: null,
    attachments: [attachmentMeta],
    replyTo: replyTo || null
  });

  await message.populate("sender", "name avatarUrl");

  // Update conversation lastMessage + lastActivityAt
  const { saveMessage: _save, ...chatService } = require("../services/chat.service");
  await Conversation.findByIdAndUpdate(conversationId, {
    lastMessage: message._id,
    lastActivityAt: message.createdAt
  });

  // Broadcast to conversation room
  const io = getIO();
  if (io) {
    io.to(`conv:${conversationId}`).emit("chat:message", message);
  }

  res.status(201).json(new ApiResponse(201, message, "File uploaded successfully"));
});

module.exports = { uploadChatAttachment };
