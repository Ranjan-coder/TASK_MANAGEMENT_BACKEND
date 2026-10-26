const express = require("express");
const resumeTenant = require("../middlewares/tenantResume.middleware");
const router = express.Router();

const chatController = require("../controllers/chat.controller");
const { uploadChatAttachment } = require("../controllers/chat.upload.controller");
const authMiddleware = require("../middlewares/auth.middleware");
// Chat files arrive encrypted (always application/octet-stream): their own filter
const upload = require("../middlewares/chatUpload.middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const Conversation = require("../models/Conversation");
const { createLimiter } = require("../middlewares/rateLimiter.middleware");

// All chat routes require authentication
router.use(authMiddleware);

// ── Rate limiter for message sending: 60 messages/min per user ───────────────
// Files: 60 per hour per person (each up to the upload size limit)
const attachmentLimiter = require("../middlewares/rateLimiter.middleware").createLimiter({
  windowMs: 60 * 60 * 1000,
  max: () => Number(process.env.CHAT_ATTACHMENT_LIMIT_PER_HOUR) || 60,
  message: "You've sent a lot of files. Please wait a little."
});
const reactionLimiter = require("../middlewares/rateLimiter.middleware").createLimiter({ windowMs: 60 * 1000, max: 60, message: "Too many reactions." });

// Shared hybrid store: uses Redis when it's up, memory otherwise (decided per request, not at load).
const messageLimiter = require("../middlewares/rateLimiter.middleware").createLimiter({
  windowMs: 60 * 1000,
  max: () => Number(process.env.CHAT_MESSAGE_LIMIT_PER_MIN) || 60,
  message: "Message rate limit exceeded. Please slow down.",
  keyGenerator: (req) => `chat:${req.user?._id || req.ip}`
});

// Mentions notify people: at most 10 mention-carrying messages a minute per person
// (plain messages aren't counted here), so @-pings can't be used to spam.
const mentionLimiter = require("../middlewares/rateLimiter.middleware").createLimiter({
  windowMs: 60 * 1000,
  max: () => Number(process.env.CHAT_MENTION_LIMIT_PER_MIN) || 10,
  message: "You've mentioned people a lot just now. Please wait a minute.",
  keyGenerator: (req) => `mention:${req.user?._id || req.ip}`,
  skip: (req) => !(Array.isArray(req.body?.mentions) && req.body.mentions.length) && !req.body?.mentionsAll
});

// ── Membership guard middleware ───────────────────────────────────────────────
const requireMembership = asyncHandler(async (req, res, next) => {
  const convId = req.params.id || req.params.conversationId;
  if (!convId) return next();

  const conv = await Conversation.findOne({
    _id: convId,
    "members.user": req.user._id
  });
  if (!conv) throw new ApiError(403, "You are not a member of this conversation");
  req.conversation = conv;
  next();
});

// ── Public Key Routes ────────────────────────────────────────────────────────
router.post("/keys/publish", chatController.publishPublicKey);
// Must come before /keys/:userId
router.get("/keys/bundle", chatController.getKeyBundle);
router.put("/keys/bundle", chatController.putKeyBundle);
router.get("/keys/recovery", chatController.getRecoveryBundle);
router.get("/keys/:userId", chatController.getPublicKey);

// ── People (staff directory) ─────────────────────────────────────────────────
// Who I can start a chat with: active staff of my organisation who have chat.
// Never customers (they chat only in project groups admins set up) and never
// email addresses. Customers can't reach this route (accessPolicy allow-list).
router.get(
  "/people",
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search.slice(0, 60) : "";
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor.slice(0, 200) : undefined;
    const page = await require("../services/directory.service").searchStaff({
      q: search,
      module: "chat",
      orgMask: req.orgModules,
      excludeId: req.user._id,
      cursor
    });
    res.status(200).json(new (require("../utils/ApiResponse"))(200, page));
  })
);

// ── Conversation Routes ──────────────────────────────────────────────────────
router.get("/conversations", chatController.getConversations);
router.post("/conversations", chatController.createConversation);

router.get("/conversations/:id", requireMembership, chatController.getConversation);
router.patch("/conversations/:id", requireMembership, chatController.updateConversation);
// My own notification choice for this chat (all / mentions only / off, snooze)
router.patch("/conversations/:id/notify", requireMembership, chatController.updateNotify);

// Group member management
router.post("/conversations/:id/members", requireMembership, chatController.addMember);
router.delete("/conversations/:id/members/:userId", requireMembership, chatController.removeMember);
router.put("/conversations/:id/group-keys", requireMembership, chatController.updateGroupKeys);
router.post("/conversations/:id/group-keys/share", requireMembership, chatController.shareGroupKeys);

// ── Message Routes ───────────────────────────────────────────────────────────
router.get("/conversations/:id/messages", requireMembership, chatController.getMessages);
router.get("/conversations/:id/threads/:rootId", requireMembership, chatController.getThread);

// Pins (the chat's) and stars (mine): chat-features-plan.md CH-P
const pinLimiter = require("../middlewares/rateLimiter.middleware").createLimiter({ windowMs: 60 * 1000, max: 30, message: "Too many pin changes." });
router.get("/conversations/:id/pins", requireMembership, chatController.getPins);
router.post("/conversations/:id/pins/:msgId", requireMembership, pinLimiter, chatController.pinMessage);
router.delete("/conversations/:id/pins/:msgId", requireMembership, pinLimiter, chatController.unpinMessage);
router.get("/starred", chatController.getStarred);

// Customer experience (P4)
router.get("/conversations/:id/service-info", requireMembership, chatController.getServiceInfo);
router.post("/conversations/:id/team-notes", requireMembership, chatController.openTeamNotes);
router.get("/conversations/:id/files", requireMembership, chatController.getFiles);
// Scheduled send: the same per-person message limits as sending now
router.get("/conversations/:id/scheduled", requireMembership, chatController.listScheduled);
router.post("/conversations/:id/scheduled", requireMembership, messageLimiter, mentionLimiter, chatController.scheduleMessage);
router.delete("/scheduled/:sid", chatController.cancelScheduled);
router.post("/messages/:id/star", reactionLimiter, chatController.starMessage);
router.delete("/messages/:id/star", reactionLimiter, chatController.unstarMessage);
router.post("/conversations/:id/messages", requireMembership, messageLimiter, mentionLimiter, chatController.sendMessage);

// Phase 2: File/image upload (pre-encrypted by client)
router.post(
  "/conversations/:id/attachments",
  requireMembership,
  messageLimiter,
  attachmentLimiter,
  resumeTenant(upload.single("file")),
  uploadChatAttachment
);

// ── Per-message Routes ───────────────────────────────────────────────────────
router.patch("/messages/:id/read", chatController.markRead);
router.patch("/messages/:id/react", reactionLimiter, chatController.reactToMessage);
router.patch("/messages/:id/edit", chatController.editMessage);
router.delete("/messages/:id", chatController.deleteMessage);

module.exports = router;
