const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/env");
const User = require("../models/User");
const Task = require("../models/Task");
const logger = require("../utils/logger");
const { registerChatEvents, setOnline } = require("./chat.socket");

let io = null;

const readCookie = (header, name) => {
  for (const part of String(header || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
};

const initSockets = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: config.clientUrl,
      credentials: true
    },
    pingTimeout: 20000 // detect dead clients (and show them offline) in ~45 s instead of ~85 s
  });

  // Socket Authentication Handshake
  io.use(async (socket, next) => {
    try {
      // Browsers attach cookies to WebSocket upgrades from any site and CORS
      // doesn't apply to them, so only accept our own app's origin.
      const origin = socket.handshake.headers?.origin;
      if (origin && origin !== config.clientUrl) {
        return next(new Error("WebSocket origin not allowed"));
      }

      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(" ")[1] ||
        readCookie(socket.handshake.headers?.cookie, "accessToken");

      if (!token) {
        return next(new Error("Authentication token required for WebSocket"));
      }

      const decoded = jwt.verify(token, config.jwt.accessSecret);
      if (decoded.stage) {
        return next(new Error("WebSocket authentication failed"));
      }
      const user = await User.findById(decoded.userId);
      if (!user || user.status === "suspended" || user.status === "inactive") {
        return next(new Error("User account unavailable or suspended"));
      }

      if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
        return next(new Error("Session revoked"));
      }
      if (!decoded.sid || !(user.currentSessions || []).some((sess) => sess.sessionId === decoded.sid)) {
        return next(new Error("Session revoked"));
      }

      // Same gates as the REST API (forced password change, required 2FA for privileged accounts)
      const { evaluateAccess } = require("../middlewares/accessPolicy");
      const gate = evaluateAccess({ user, method: "GET", originalUrl: "/api/v1/chat/conversations" });
      if (!gate.allowed && gate.code !== "ROLE_SCOPE_DENIED") {
        return next(new Error("Complete your account setup first"));
      }

      socket.user = user;
      socket.data.sessionId = decoded.sid;
      next();
    } catch (err) {
      next(new Error("WebSocket authentication failed"));
    }
  });

  io.on("connection", async (socket) => {
    logger.debug(`Socket connected: ${socket.id} (User: ${socket.user.name})`);

    // Automatically join user's private notification room
    socket.join(`user:${socket.user._id}`);


    // Join task room with access verification
    socket.on("join:task", async ({ taskId }) => {
      try {
        const task = await Task.findById(taskId).select("assignedBy assignedTo watchers").lean();
        if (!task) return;

        const userId = socket.user._id.toString();
        const hasAccess =
          socket.user.role === "superadmin" ||
          socket.user.role === "admin" ||
          task.assignedBy.toString() === userId ||
          task.assignedTo.some((u) => u.toString() === userId) ||
          task.watchers.some((u) => u.toString() === userId);

        if (hasAccess) {
          socket.join(`task:${taskId}`);
          logger.debug(`User ${socket.user.name} joined room task:${taskId}`);
        }
      } catch (err) {
        logger.error(`Error joining task room: ${err.message}`);
      }
    });

    socket.on("leave:task", ({ taskId }) => {
      socket.leave(`task:${taskId}`);
    });

    // Register all chat-related socket events
    registerChatEvents(socket, io);

    // Presence after handlers are registered (awaiting it first dropped early
    // join:conversation events) and without blocking the connection.
    setOnline(socket.user._id.toString(), io).catch((err) => logger.warn(`setOnline failed: ${err.message}`));

    socket.on("disconnect", () => {
      logger.debug(`Socket disconnected: ${socket.id}`);
    });
  });


  return io;
};

const getIO = () => io;

/** Closes live connections of signed-out sessions (all of the user's if no sessionId). */
const disconnectSessions = async (userId, sessionIds = null) => {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    if (!sessionIds || sessionIds.includes(s.data?.sessionId)) s.disconnect(true);
  }
};

module.exports = { initSockets, getIO, disconnectSessions };
