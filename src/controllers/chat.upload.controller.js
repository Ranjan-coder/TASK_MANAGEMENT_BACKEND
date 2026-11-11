const crypto = require("crypto");
const cloudinary = require("../config/cloudinary");
const { orgFolder } = require("../services/media.service");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const { getIO } = require("../sockets");

// Declared types a chat file may have → what the app shows it as
const ALLOWED_TYPES = new Map([
  ["application/pdf", "doc"],
  ["application/msword", "doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "doc"],
  ["application/vnd.ms-excel", "doc"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "doc"],
  ["image/jpeg", "image"],
  ["image/png", "image"],
  ["image/webp", "image"],
  ["image/gif", "image"],
  // Voice notes (what browsers record: Chrome/Firefox webm or ogg opus, Safari mp4)
  ["audio/webm", "audio"],
  ["audio/ogg", "audio"],
  ["audio/mp4", "audio"],
  ["audio/mpeg", "audio"],
  ["audio/aac", "audio"]
]);
const FILE_TYPES = new Set(["pdf", "doc", "docx", "xls", "xlsx", "image", "audio", "other"]);

// The file name's extension must match the declared type: the bytes are encrypted and
// can't be checked, so this is what stops "Quote.pdf.exe" being sent as a PDF
const EXTENSIONS = {
  "application/pdf": ["pdf"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "audio/webm": ["webm", "weba"],
  "audio/ogg": ["ogg", "oga", "opus"],
  "audio/mp4": ["m4a", "mp4"],
  "audio/mpeg": ["mp3"],
  "audio/aac": ["aac", "m4a"]
};
// Control characters and bidirectional overrides ("Quote‮fdp.exe" displays as "Quoteexe.pdf")
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩\\/:*?"<>|]/g;

/** A file name that's safe to show and save, with an extension matching its declared type. */
const safeFileName = (name, mime) => {
  const clean = String(name || "").replace(UNSAFE_NAME_CHARS, "").replace(/\s+/g, " ").trim().slice(0, 200);
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 ? clean.slice(dot + 1).toLowerCase() : "";
  if (!clean || !EXTENSIONS[mime]?.includes(ext)) {
    throw new ApiError(400, "The file name doesn't match its type", [{ code: "FILE_NAME_MISMATCH" }]);
  }
  return clean;
};

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

  // Which key encrypted the file (sent as JSON in the multipart form)
  let keyRef;
  if (req.body.keyRef) {
    let parsedRef;
    try {
      parsedRef = JSON.parse(String(req.body.keyRef).slice(0, 200));
    } catch {
      throw new ApiError(400, "Invalid keyRef");
    }
    keyRef = require("../services/groupKeys.service").parseKeyRef(parsedRef, req.conversation);
  }

  if (!originalName) throw new ApiError(400, "originalName is required");
  if (!encryptedFileKey || !fileIv) throw new ApiError(400, "encryptedFileKey and fileIv are required");
  // What the encrypted file is: declared by the sender's app, checked here (the bytes can't be)
  const declared = String(mimeType || "").toLowerCase().split(";")[0].trim();
  const kind = ALLOWED_TYPES.get(declared);
  if (!kind) throw new ApiError(400, "This kind of file can't be sent in chat", [{ code: "FILE_TYPE_NOT_ALLOWED" }]);
  if (fileType && !FILE_TYPES.has(fileType)) throw new ApiError(400, "Invalid fileType");
  const displayName = safeFileName(originalName, declared);
  // Voice notes: length in seconds, shown before playing (at most 10 minutes)
  let durationSec;
  if (req.body.durationSec !== undefined && req.body.durationSec !== "") {
    durationSec = Number(req.body.durationSec);
    if (kind !== "audio" || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600) throw new ApiError(400, "Invalid voice note length");
    durationSec = Math.round(durationSec);
  }
  if (String(originalName).length > 200 || String(mimeType || "").length > 100 || String(encryptedFileKey).length > 1000 || String(fileIv).length > 64) {
    throw new ApiError(400, "File details are too long");
  }
  await require("./chat.controller").assertReplyInConversation(replyTo, conversationId);
  // A file sent inside a thread (multipart fields are strings)
  const threadRoot = await require("./chat.controller").parseThreadRoot(req.body.threadRoot, conversationId);
  const alsoInChat = Boolean(threadRoot && String(req.body.alsoInChat) === "true");

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
              folder: orgFolder("chat_attachments"),
              timeout: 60000,
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

  // Images and audio are always labelled as such; documents keep the app's finer type
  const resolvedFileType = kind === "image" || kind === "audio" ? kind : fileType && fileType !== "image" && fileType !== "audio" ? fileType : "other";

  // Build attachment metadata (no plaintext content stored)
  const attachmentMeta = {
    fileName: uniqueId,
    originalName: displayName,
    fileType: resolvedFileType,
    mimeType: declared,
    // From the bytes received (ciphertext = plaintext + 16-byte GCM tag), not the client's claim
    fileSize: Math.max(0, req.file.size - 16),
    durationSec,
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
    replyTo: replyTo || null,
    keyRef,
    threadRoot: threadRoot || null,
    alsoInChat: threadRoot && alsoInChat ? true : undefined
  });

  await message.populate("sender", "name avatarUrl");

  // Update conversation lastMessage + lastActivityAt (a file only inside a thread leaves the preview alone)
  if (!threadRoot || alsoInChat) {
    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: message._id,
      lastActivityAt: message.createdAt
    });
  }

  // To every member (open chat + personal rooms; one copy per connection)
  const io = getIO();
  if (io) {
    io.to([`conv:${conversationId}`, ...conv.members.map((m) => `user:${m.user?._id || m.user}`)]).emit("chat:message", message);
  }
  if (threadRoot) await require("./chat.controller").afterThreadReply({ message, threadRoot, conversation: conv, sender: req.user, io });

  await require("../services/sla.service").onMessage({ conversation: conv, sender: req.user });
  await require("../services/offlineAlerts.service").onStaffMessage({ conversation: conv, sender: req.user });

  res.status(201).json(new ApiResponse(201, message, "File uploaded successfully"));
});

module.exports = { uploadChatAttachment };
