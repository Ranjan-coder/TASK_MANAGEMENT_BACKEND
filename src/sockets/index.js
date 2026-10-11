const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/env");
const User = require("../models/User");
const Task = require("../models/Task");
const logger = require("../utils/logger");
const { registerChatEvents, setOnline } = require("./chat.socket");
const tenant = require("../utils/tenantContext");
const { getOrgStatus, getEntitlements } = require("../services/organisation.service");
const { effectiveUserMask } = require("../services/moduleAccess.service");
const modules = require("../config/modules");

// Which module a client event belongs to (null = core, always allowed).
// Packaged modules declare their event prefixes in their manifest.
const MANIFEST_EVENTS = require("../modules/catalog").MANIFESTS.flatMap((m) => (m.events || []).map((prefix) => [prefix, m.key]));
const moduleForEvent = (event) => {
  const name = String(event || "");
  for (const [prefix, key] of MANIFEST_EVENTS) if (name.startsWith(prefix)) return key;
  if (name.startsWith("chat:") || name.endsWith(":conversation") || name === "presence:heartbeat") return "chat";
  if (name.endsWith(":task")) return "tasks";
  return null;
};
const { isPlatformUser, runAsAccount } = require("../services/accountLookup.service");

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
      const user = await tenant.runAsSystem(() => User.findById(decoded.userId));
      if (!user || user.status === "suspended" || user.status === "inactive") {
        return next(new Error("User account unavailable or suspended"));
      }
      if (!isPlatformUser(user) && (await getOrgStatus(user.orgId)) !== "active") {
        return next(new Error("Organisation access is paused"));
      }
      // Same rule as the REST gate: customers exist only in the customer portal
      if (user.role === "customer" && !((await getEntitlements(user.orgId)).mask & modules.BIT.customer_portal)) {
        return next(new Error("MODULE_DISABLED"));
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

  io.on("connection", (socket) => runAsAccount(socket.user, () => onConnection(socket)));

  const onConnection = (socket) => {
    logger.debug(`Socket connected: ${socket.id} (User: ${socket.user.name})`);

    // Every event this socket sends is handled inside its user's organisation
    // (the handlers' database queries are scoped by the tenant plugin)
    const store = isPlatformUser(socket.user) ? { platform: true, orgId: null } : { orgId: socket.user.orgId };
    socket.use((packet, next) => tenant.runWithStore(store, () => next()));

    // Module gate for live events (same rule as the REST gate): chat events need
    // the chat module, task rooms need tasks. Entitlements are cached, so O(1).
    socket.use(async (packet, next) => {
      const key = moduleForEvent(packet[0]);
      if (!key) return next();
      if (isPlatformUser(socket.user)) return next(new Error("MODULE_DISABLED"));
      // Organisation AND person (socket.user is re-read on every reconnect;
      // changing someone's modules disconnects them, see moduleAccess routes)
      const { mask, customerMask } = await getEntitlements(socket.user.orgId);
      if (!(effectiveUserMask(socket.user, mask, customerMask) & modules.BIT[key])) {
        return next(new Error("MODULE_DISABLED"));
      }
      next();
    });
    socket.on("error", () => {}); // refused events end here; the connection stays up

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
  };


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
