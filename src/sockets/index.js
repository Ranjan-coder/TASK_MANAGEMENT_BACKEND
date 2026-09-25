const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/env");
const User = require("../models/User");
const Task = require("../models/Task");
const logger = require("../utils/logger");
const { registerChatEvents, setOnline } = require("./chat.socket");

let io = null;

const initSockets = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: config.clientUrl,
      credentials: true
    },
    pingTimeout: 60000
  });

  // Socket Authentication Handshake
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(" ")[1];

      if (!token) {
        return next(new Error("Authentication token required for WebSocket"));
      }

      const decoded = jwt.verify(token, config.jwt.accessSecret);
      const user = await User.findById(decoded.userId);
      if (!user || user.status === "suspended") {
        return next(new Error("User account unavailable or suspended"));
      }

      if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
        return next(new Error("Session revoked"));
      }

      socket.user = user;
      next();
    } catch (err) {
      next(new Error("WebSocket authentication failed"));
    }
  });

  io.on("connection", async (socket) => {
    logger.info(`Socket connected: ${socket.id} (User: ${socket.user.name})`);

    // Automatically join user's private notification room
    socket.join(`user:${socket.user._id}`);

    // Set user online in Redis + broadcast presence
    await setOnline(socket.user._id.toString(), io);

    // Join task room with access verification
    socket.on("join:task", async ({ taskId }) => {
      try {
        const task = await Task.findById(taskId);
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

    socket.on("disconnect", () => {
      logger.info(`Socket disconnected: ${socket.id}`);
    });
  });


  return io;
};

const getIO = () => io;

module.exports = { initSockets, getIO };
