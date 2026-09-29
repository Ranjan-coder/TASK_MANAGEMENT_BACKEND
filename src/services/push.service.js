const webpush = require("web-push");
const config = require("../config/env");
const logger = require("../utils/logger");
const PushSubscription = require("../models/PushSubscription");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const { describeDevice } = require("../utils/device");

/**
 * Web push for the installable app (R7). Payloads are encrypted for the
 * browser by the Web Push protocol, so the push service can't read them.
 * Pushes only go to devices whose sign-in session is still active.
 */

const configured = Boolean(config.push.publicKey && config.push.privateKey);
if (configured) webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);

const MAX_PER_USER = 10;
const ALLOWED_PUSH_HOSTS = [
  /(^|\.)googleapis\.com$/, // Chrome, Edge (FCM)
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)notify\.windows\.com$/, // Edge (WNS)
  /(^|\.)push\.apple\.com$/ // Safari
];

const isPushEndpoint = (endpoint) => {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && ALLOWED_PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
};

const subscribe = async ({ user, sessionId, subscription, userAgent }) => {
  if (!configured) throw new ApiError(503, "Push notifications aren't set up on the server");
  // Only real browser push services: stops the server being used to call arbitrary URLs
  if (!isPushEndpoint(subscription.endpoint)) throw new ApiError(400, "Unsupported push service");
  const doc = await PushSubscription.findOneAndUpdate(
    { endpoint: subscription.endpoint },
    { $set: { user: user._id, sessionId, keys: subscription.keys, deviceName: describeDevice(userAgent || "") } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  // Keep the newest few per person
  const extra = await PushSubscription.find({ user: user._id }).sort({ updatedAt: -1 }).skip(MAX_PER_USER).select("_id");
  if (extra.length) await PushSubscription.deleteMany({ _id: { $in: extra.map((e) => e._id) } });
  return doc;
};

const unsubscribe = (userId, endpoint) => PushSubscription.deleteOne({ user: userId, endpoint });

const hasActiveSubscription = async (userId) => {
  const user = await User.findById(userId).select("currentSessions.sessionId");
  const sids = (user?.currentSessions || []).map((s) => s.sessionId);
  return Boolean(await PushSubscription.exists({ user: userId, sessionId: { $in: sids } }));
};

/**
 * Sends a push to every active device of a user. Returns the number delivered.
 * payload: { title, body, url, tag }
 */
const sendToUser = async (userId, payload) => {
  if (!configured) return 0;
  const [subs, user] = await Promise.all([
    PushSubscription.find({ user: userId }),
    User.findById(userId).select("status currentSessions.sessionId")
  ]);
  if (!subs.length || !user || user.status !== "active") return 0;
  const active = new Set((user.currentSessions || []).map((s) => s.sessionId));
  const body = JSON.stringify({
    title: String(payload.title || "Bonito").slice(0, 120),
    body: String(payload.body || "").slice(0, 300),
    url: typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/",
    tag: payload.tag ? String(payload.tag).slice(0, 64) : undefined
  });

  let delivered = 0;
  await Promise.all(
    subs.map(async (sub) => {
      if (!active.has(sub.sessionId)) {
        await sub.deleteOne(); // that device was signed out
        return;
      }
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 6 * 3600, urgency: "normal" });
        delivered += 1;
        await PushSubscription.updateOne({ _id: sub._id }, { lastSuccessAt: new Date() });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await sub.deleteOne(); // expired subscription
        else logger.warn(`Push failed (${err.statusCode || "network"}): ${err.message}`);
      }
    })
  );
  return delivered;
};

/** Where an in-app notification opens on the phone. */
const urlForNotification = (n) => {
  if (n.relatedTask) return `/tasks/${n.relatedTask}`;
  if (n.relatedConversation) return `/chat/${n.relatedConversation}`;
  return "/notifications";
};

module.exports = { configured, publicKey: config.push.publicKey, subscribe, unsubscribe, sendToUser, hasActiveSubscription, urlForNotification, isPushEndpoint };
