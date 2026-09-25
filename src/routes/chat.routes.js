const express = require("express");
const router = express.Router();

const chatController = require("../controllers/chat.controller");
const { uploadChatAttachment } = require("../controllers/chat.upload.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const upload = require("../middlewares/upload.middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const Conversation = require("../models/Conversation");
const { createLimiter } = require("../middlewares/rateLimiter.middleware");

// All chat routes require authentication
router.use(authMiddleware);

// ── Rate limiter for message sending: 60 messages/min per user ───────────────
const messageLimiter = (() => {
  try {
    const rateLimit = require("express-rate-limit");
    const { RedisStore } = require("rate-limit-redis");
    const redisClient = require("../config/redis");
    const ApiError = require("../utils/ApiError");

    const options = {
      windowMs: 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `chat:${req.user?._id || req.ip}`,
      handler: (req, res, next) => next(new ApiError(429, "Message rate limit exceeded. Please slow down."))
    };

    if (redisClient?.status === "ready") {
      options.store = new RedisStore({ sendCommand: (...args) => redisClient.call(...args) });
    }
    return rateLimit(options);
  } catch {
    return (req, res, next) => next(); // fallback: no rate limiting if deps missing
  }
})();

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
router.get("/keys/:userId", chatController.getPublicKey);

// ── Conversation Routes ──────────────────────────────────────────────────────
router.get("/conversations", chatController.getConversations);
router.post("/conversations", chatController.createConversation);

router.get("/conversations/:id", requireMembership, chatController.getConversation);
router.patch("/conversations/:id", requireMembership, chatController.updateConversation);

// Group member management
router.post("/conversations/:id/members", requireMembership, chatController.addMember);
router.delete("/conversations/:id/members/:userId", requireMembership, chatController.removeMember);
router.put("/conversations/:id/group-keys", requireMembership, chatController.updateGroupKeys);

// ── Message Routes ───────────────────────────────────────────────────────────
router.get("/conversations/:id/messages", requireMembership, chatController.getMessages);
router.post("/conversations/:id/messages", requireMembership, messageLimiter, chatController.sendMessage);

// Phase 2: File/image upload (pre-encrypted by client)
router.post(
  "/conversations/:id/attachments",
  requireMembership,
  upload.single("file"),
  uploadChatAttachment
);

// ── Per-message Routes ───────────────────────────────────────────────────────
router.patch("/messages/:id/read", chatController.markRead);
router.patch("/messages/:id/react", chatController.reactToMessage);
router.patch("/messages/:id/edit", chatController.editMessage);
router.delete("/messages/:id", chatController.deleteMessage);

module.exports = router;
