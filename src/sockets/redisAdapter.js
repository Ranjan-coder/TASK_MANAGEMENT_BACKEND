/**
 * Shares Socket.IO rooms between server instances through Redis pub/sub
 * (chat-features-plan.md §5). Without it, an event emitted on one instance
 * never reaches people connected to another one.
 *
 * Redis stays optional: with no REDIS_URL, or when it can't be reached at
 * start-up, Socket.IO keeps its default in-memory adapter (one instance).
 */
const { createAdapter } = require("@socket.io/redis-adapter");
const redisClient = require("../config/redis");
const config = require("../config/env");
const logger = require("../utils/logger");

const READY_TIMEOUT_MS = 3000;

const waitReady = (client) =>
  new Promise((resolve) => {
    if (client.status === "ready") return resolve(true);
    const done = (ok) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      resolve(ok);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), READY_TIMEOUT_MS);
    client.on("ready", onReady);
    if (client.status === "wait") client.connect().catch(() => done(false));
  });

/**
 * The adapter doesn't await its publishes, so a Redis outage would surface as
 * unhandled rejections. Failed publishes are logged instead: this instance
 * still delivers to its own sockets, and Redis reconnects on its own.
 */
const safePublisher = (client) => {
  const publish = client.publish.bind(client);
  client.publish = (...args) =>
    publish(...args).catch((err) => {
      logger.warn(`Socket broadcast to other servers failed: ${err.message}`);
      return 0;
    });
  return client;
};

/** Attaches the Redis adapter to `io` when Redis is available; resolves to true if attached. */
const attachRedisAdapter = async (io) => {
  if (!redisClient || config.env === "test") return false;
  // Pub/sub needs its own connections (a subscribed connection can't run other commands)
  const pub = safePublisher(redisClient.duplicate({ enableOfflineQueue: true }));
  const sub = redisClient.duplicate({ enableOfflineQueue: true });
  for (const c of [pub, sub]) c.on("error", (err) => err.code !== "ECONNREFUSED" && logger.error(`Socket Redis: ${err.message}`));

  const [pubOk, subOk] = await Promise.all([waitReady(pub), waitReady(sub)]);
  if (!pubOk || !subOk) {
    pub.disconnect();
    sub.disconnect();
    logger.warn("Redis unavailable: live updates run on this server only");
    return false;
  }
  io.adapter(createAdapter(pub, sub));
  logger.info("Socket.IO Redis adapter attached (multi-server live updates)");
  return true;
};

module.exports = { attachRedisAdapter };
