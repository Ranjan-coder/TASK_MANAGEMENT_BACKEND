const Conversation = require("../models/Conversation");
const logger = require("../utils/logger");
const redisClient = require("../config/redis");
const chatService = require("../services/chat.service");
const { runAsAccount } = require("../services/accountLookup.service");
const { markDelivered, teamRoom, customerRoom, chatRooms } = require("../services/receipt.service");

// Typing debounce timers: Map<`${socketId}:${convId}`, NodeJS.Timeout>
const typingTimers = new Map();

/**
 * Set user online in Redis with 70s TTL (heartbeat refreshes every 60s from client)
 */
/** Rooms of everyone who shares a chat with this user (presence isn't broadcast to the whole app). */
// Short-lived cache: a reconnect storm (deploy, flaky network) would otherwise run
// this 500-conversation query on every connect AND disconnect.
const PARTNER_TTL_MS = 60 * 1000;
const partnerCache = new Map(); // userId → { at, rooms }
const partnerRooms = async (userId) => {
  const hit = partnerCache.get(String(userId));
  if (hit && Date.now() - hit.at < PARTNER_TTL_MS) return hit.rooms;
  const convs = await Conversation.find({ "members.user": userId, isArchived: false }).select("members.user").limit(500).lean();
  const ids = new Set();
  for (const c of convs) for (const m of c.members) if (String(m.user) !== String(userId)) ids.add(`user:${m.user}`);
  const rooms = [...ids];
  if (partnerCache.size > 5000) partnerCache.clear();
  partnerCache.set(String(userId), { at: Date.now(), rooms });
  return rooms;
};

const emitPresence = async (io, userId, isOnline) => {
  try {
    const rooms = await partnerRooms(userId);
    if (rooms.length) io.to(rooms).emit("presence:update", { userId, isOnline });
  } catch (err) {
    logger.warn(`Presence update failed: ${err.message}`);
  }
};

const receiptBuckets = new Map(); // userId → { tokens, at } (this server; enough to stop floods)
const allowReceipt = (userId) => {
  const now = Date.now();
  if (receiptBuckets.size > 20000) receiptBuckets.clear();
  const b = receiptBuckets.get(userId) || { tokens: 60, at: now };
  b.tokens = Math.min(60, b.tokens + ((now - b.at) / 60000) * 120);
  b.at = now;
  receiptBuckets.set(userId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
};

const isConvId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);

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

  // Receipt events: a token bucket per PERSON (120 per minute, bursts of 60), shared by
  // all their connections, so opening many sockets doesn't multiply the write rate
  const allow = () => allowReceipt(userId);

  // ── Join / Leave conversation room ─────────────────────────────────────────
  socket.on("join:conversation", async ({ conversationId } = {}) => {
    // A plain id only (an object here would reach the query as an operator)
    if (!isConvId(conversationId)) return;
    try {
      // Verify membership before allowing room join
      const conv = await Conversation.exists({ _id: conversationId, "members.user": userId });
      if (!conv) {
        return socket.emit("chat:error", { code: "NOT_MEMBER", message: "Access denied to conversation" });
      }
      // Plus the receipts room for this person's side: the team sees who read what,
      // customers only that the team did (receipt.service.js, CH-D3)
      const side = socket.user.role === "customer" ? customerRoom(conversationId) : teamRoom(conversationId);
      socket.join([`conv:${conversationId}`, side]);
      logger.debug(`User ${socket.user.name} joined conv:${conversationId}`);
    } catch (err) {
      logger.error(`join:conversation error: ${err.message}`);
    }
  });

  socket.on("leave:conversation", ({ conversationId } = {}) => {
    if (!isConvId(conversationId)) return;
    for (const room of chatRooms(conversationId)) socket.leave(room);
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
    if (!allow()) return;
    try {
      // Receipt to the chat's open screens (team / customer views) happens inside
      await chatService.markAsRead(conversationId, userId);
      // My other tabs and devices clear their unread badge
      io.to(`user:${userId}`).emit("chat:read", { conversationId, userId, lastRead: new Date() });
    } catch (err) {
      logger.error(`chat:read error: ${err.message}`);
    }
  });

  // ── Delivered (✓✓): "my app has received this chat's messages up to t" ────
  // One item or a list (after loading the conversation list). Membership is
  // part of the update filter, so a non-member's event changes nothing.
  socket.on("chat:delivered", async (payload) => {
    const items = (Array.isArray(payload) ? payload : [payload]).slice(0, 50);
    for (const item of items) {
      const { conversationId, upTo } = item || {};
      if (typeof conversationId !== "string" || !/^[a-f0-9]{24}$/i.test(conversationId) || typeof upTo !== "string") continue;
      if (!allow()) return;
      try {
        await markDelivered(io, conversationId, userId, upTo);
      } catch (err) {
        logger.error(`chat:delivered error: ${err.message}`);
      }
    }
  });

  // ── Presence heartbeat (refreshes Redis TTL) ───────────────────────────────
  socket.on("presence:heartbeat", async () => {
    if (redisClient?.status === "ready") {
      await redisClient.expire(`presence:${userId}`, 70);
    }
  });

  // ── Cleanup on disconnect ──────────────────────────────────────────────────
  // "disconnect" is a reserved event: it skips socket.use(), so it re-enters the
  // user's organisation itself (presence looks up their conversations)
  socket.on("disconnect", () => runAsAccount(socket.user, onDisconnect));
  const onDisconnect = async () => {
    // Clean up typing timers for this socket
    for (const [key] of typingTimers) {
      if (key.startsWith(`${socket.id}:`)) {
        clearTimeout(typingTimers.get(key));
        typingTimers.delete(key);
      }
    }
    // Another tab or device may still be connected; only then go offline.
    try {
      const remaining = await io.in(`user:${userId}`).fetchSockets();
      if (remaining.length) return;
    } catch { /* fall through */ }
    await setOffline(userId, io);
  };
};

/**
 * A group admin came online: chats of theirs where someone still has no key
 * (or a removal needs a new key) get handled now by their app, instead of
 * whenever they next open that chat.
 */
const requestPendingKeyHelp = async (userId, io) => {
  const { requestKeyHelp } = require("../services/groupKeys.service");
  const groups = await Conversation.find({ type: "group", members: { $elemMatch: { user: userId, role: "admin" } } })
    .select("type members groupKeyring rekeyRequested")
    .populate("members.user", "publicKey")
    .limit(200)
    .lean();
  let asked = 0;
  for (const g of groups) if (requestKeyHelp(io, g, userId)) asked++;
  return asked;
};

module.exports = { registerChatEvents, setOnline, requestPendingKeyHelp };
