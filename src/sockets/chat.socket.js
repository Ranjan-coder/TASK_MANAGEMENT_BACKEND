const Conversation = require("../models/Conversation");
const logger = require("../utils/logger");
const redisClient = require("../config/redis");
const chatService = require("../services/chat.service");

// Typing debounce timers: Map<`${socketId}:${convId}`, NodeJS.Timeout>
const typingTimers = new Map();

/**
 * Set user online in Redis with 70s TTL (heartbeat refreshes every 60s from client)
 */
/** Rooms of everyone who shares a chat with this user (presence isn't broadcast to the whole app). */
const partnerRooms = async (userId) => {
  const convs = await Conversation.find({ "members.user": userId, isArchived: false }).select("members.user").limit(500).lean();
  const ids = new Set();
  for (const c of convs) for (const m of c.members) if (String(m.user) !== String(userId)) ids.add(`user:${m.user}`);
  return [...ids];
};

const emitPresence = async (io, userId, isOnline) => {
  try {
    const rooms = await partnerRooms(userId);
    if (rooms.length) io.to(rooms).emit("presence:update", { userId, isOnline });
  } catch (err) {
    logger.warn(`Presence update failed: ${err.message}`);
  }
};

const inRoom = (socket, conversationId) => typeof conversationId === "string" && /^[a-f0-9]{24}$/i.test(conversationId) && socket.rooms.has(`conv:${conversationId}`);

const setOnline = async (userId, io) => {
  if (redisClient?.status === "ready") {
    await redisClient.set(`presence:${userId}`, "1", "EX", 70);
  }
  await emitPresence(io, userId, true);
};

/**
 * Clear online status from Redis and broadcast offline
 */
const setOffline = async (userId, io) => {
  if (redisClient?.status === "ready") {
    await redisClient.del(`presence:${userId}`);
  }
  await emitPresence(io, userId, false);
};

/**
 * Register all chat-related socket events for a connected socket.
 * Called from sockets/index.js inside the `io.on("connection")` handler.
 */
const registerChatEvents = (socket, io) => {
  const userId = socket.user._id.toString();

  // ── Join / Leave conversation room ─────────────────────────────────────────
  socket.on("join:conversation", async ({ conversationId }) => {
    try {
      // Verify membership before allowing room join
      const conv = await Conversation.findOne({
        _id: conversationId,
        "members.user": userId
      });
      if (!conv) {
        return socket.emit("chat:error", { code: "NOT_MEMBER", message: "Access denied to conversation" });
      }
      socket.join(`conv:${conversationId}`);
      logger.debug(`User ${socket.user.name} joined conv:${conversationId}`);
    } catch (err) {
      logger.error(`join:conversation error: ${err.message}`);
    }
  });

  socket.on("leave:conversation", ({ conversationId }) => {
    socket.leave(`conv:${conversationId}`);
  });

  // ── Typing indicators ──────────────────────────────────────────────────────
  socket.on("chat:typing:start", ({ conversationId } = {}) => {
    if (!inRoom(socket, conversationId)) return;
    const key = `${socket.id}:${conversationId}`;

    // Broadcast to all others in the room
    socket.to(`conv:${conversationId}`).emit("chat:typing", {
      conversationId,
      userId,
      name: socket.user.name,
      isTyping: true
    });

    // Auto-stop after 4s (prevents ghost typing if client disconnects mid-type)
    if (typingTimers.has(key)) clearTimeout(typingTimers.get(key));
    typingTimers.set(
      key,
      setTimeout(() => {
        socket.to(`conv:${conversationId}`).emit("chat:typing", {
          conversationId,
          userId,
          name: socket.user.name,
          isTyping: false
        });
        typingTimers.delete(key);
      }, 4000)
    );
  });

  socket.on("chat:typing:stop", ({ conversationId } = {}) => {
    if (!inRoom(socket, conversationId)) return;
    const key = `${socket.id}:${conversationId}`;
    if (typingTimers.has(key)) {
      clearTimeout(typingTimers.get(key));
      typingTimers.delete(key);
    }
    socket.to(`conv:${conversationId}`).emit("chat:typing", {
      conversationId,
      userId,
      name: socket.user.name,
      isTyping: false
    });
  });

  // ── Read receipt via socket (alternative to REST) ──────────────────────────
  socket.on("chat:read", async ({ conversationId } = {}) => {
    if (!inRoom(socket, conversationId)) return;
    try {
      await chatService.markAsRead(conversationId, userId);
      socket.to(`conv:${conversationId}`).emit("chat:read", {
        conversationId,
        userId,
        lastRead: new Date()
      });
    } catch (err) {
      logger.error(`chat:read error: ${err.message}`);
    }
  });

  // ── Presence heartbeat (refreshes Redis TTL) ───────────────────────────────
  socket.on("presence:heartbeat", async () => {
    if (redisClient?.status === "ready") {
      await redisClient.expire(`presence:${userId}`, 70);
    }
  });

  // ── Cleanup on disconnect ──────────────────────────────────────────────────
  socket.on("disconnect", async () => {
    // Clean up typing timers for this socket
    for (const [key] of typingTimers) {
      if (key.startsWith(`${socket.id}:`)) {
        clearTimeout(typingTimers.get(key));
        typingTimers.delete(key);
      }
    }
    await setOffline(userId, io);
  });
};

module.exports = { registerChatEvents, setOnline };
