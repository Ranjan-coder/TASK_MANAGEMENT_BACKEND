const crypto = require("crypto");
const config = require("../config/env");
const logger = require("./logger");

/**
 * Cross-server cache invalidation over Redis pub/sub.
 *
 * Each server keeps small in-memory caches (organisation status, entitlements …).
 * When one server changes something it clears its own copy at once and publishes
 * { topic, id }; every other server clears its copy on receipt. Without Redis the
 * caches' short TTL (30 s) is the fallback, so correctness never depends on it.
 *
 * Handlers are kept in a Map<topic, Set<fn>>: O(1) dispatch per message.
 */
const CHANNEL = "cache:invalidate";
const SERVER_ID = crypto.randomUUID(); // ignore our own messages (already cleared locally)
const handlers = new Map();

let publisher = null;
let subscriber = null;

/** Connects the subscriber. Called once by the server (scripts never start it). */
const start = () => {
  if (subscriber || config.env === "test") return;
  const client = require("../config/redis");
  if (!client) return;
  publisher = client;
  subscriber = client.duplicate();
  subscriber.on("error", () => {}); // connection errors are already logged by the main client
  subscriber
    .connect()
    .then(() => subscriber.subscribe(CHANNEL))
    .catch(() => {});
  subscriber.on("message", (channel, raw) => {
    if (channel !== CHANNEL) return;
    try {
      const { topic, id, from } = JSON.parse(raw);
      if (from === SERVER_ID) return;
      for (const fn of handlers.get(topic) || []) fn(id);
    } catch (err) {
      logger.warn(`[CacheBus] bad message: ${err.message}`);
    }
  });
};

/** Registers a local invalidation handler for a topic (e.g. "entitlements"). */
const onInvalidate = (topic, fn) => {
  if (!handlers.has(topic)) handlers.set(topic, new Set());
  handlers.get(topic).add(fn);
};

/** Tells the other servers to clear `id` under `topic`. Never throws. */
const publishInvalidate = (topic, id) => {
  if (!publisher || publisher.status !== "ready") return;
  publisher.publish(CHANNEL, JSON.stringify({ topic, id: String(id), from: SERVER_ID })).catch(() => {});
};

module.exports = { start, onInvalidate, publishInvalidate };
