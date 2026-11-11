/**
 * @mentions and per-person notification settings (chat-features-plan.md CH-M, CH-P).
 *
 * The message text is end-to-end encrypted, so the sender's app sends who it
 * mentions as plain ids next to the ciphertext (decision CH-D1). Here:
 *   - the list is checked (current members, not the sender, at most 50; the
 *     rules for @everyone / @here and for customers, decision CH-D2)
 *   - each mentioned person's unread-mention counter goes up (one bulk write)
 *   - they're notified, unless they switched the chat off, snoozed it, or are
 *     looking at it right now. Notification text is generic: it never
 *     contains the message.
 */
const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const redisClient = require("../config/redis");
const ChatMemberState = require("../models/ChatMemberState");
const Notification = require("../models/Notification");
const { ROLES } = require("../config/roles");

const MAX_MENTIONS = 50;
const NOTIFY_LEVELS = ["all", "mentions", "off"];
// Snooze choices offered by the app; anything else is refused
const MUTE_FOR_MS = { "1h": 3600e3, "8h": 8 * 3600e3, "1w": 7 * 24 * 3600e3, always: null };

const isObjectId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
const isCustomer = (user) => user?.role === ROLES.CUSTOMER;

/** May this person use @everyone / @here in this chat? (CH-D2) */
const canMentionAll = (conversation, sender) => {
  if (conversation.type !== "group" || isCustomer(sender)) return false;
  if (conversation.project) return true; // staff of a project chat
  const me = conversation.members.find((m) => String(m.user) === String(sender._id));
  return me?.role === "admin";
};

/**
 * Checks what a send says it mentions. Returns { mentions, mentionsAll }
 * ready to store (undefined when nothing is mentioned) or throws 400/403.
 */
const parseMentions = ({ mentions, mentionsAll }, { conversation, sender }) => {
  const out = { mentions: undefined, mentionsAll: undefined };

  if (mentionsAll !== undefined && mentionsAll !== null) {
    if (!["everyone", "here"].includes(mentionsAll)) throw new ApiError(400, "Invalid mentionsAll");
    if (!canMentionAll(conversation, sender)) {
      throw new ApiError(403, `You can't use @${mentionsAll} in this chat`, [{ code: "MENTION_ALL_DENIED" }]);
    }
    out.mentionsAll = mentionsAll;
  }

  if (mentions === undefined || mentions === null) return out;
  if (!Array.isArray(mentions) || mentions.length > MAX_MENTIONS || !mentions.every(isObjectId)) {
    throw new ApiError(400, `Mentions must be a list of up to ${MAX_MENTIONS} people`);
  }
  const memberIds = new Set(conversation.members.map((m) => String(m.user)));
  const ids = [...new Set(mentions.map((id) => id.toLowerCase()))].filter((id) => id !== String(sender._id));
  if (ids.some((id) => !memberIds.has(id))) {
    throw new ApiError(400, "You can only mention people in this chat", [{ code: "MENTION_NOT_MEMBER" }]);
  }
  // Customers talk to the team: they can't ping other customers of the project
  if (isCustomer(sender)) {
    const customers = new Set((conversation.project?.customers || []).map(String));
    if (ids.some((id) => customers.has(id))) {
      throw new ApiError(403, "You can only mention the project team", [{ code: "MENTION_CUSTOMER_DENIED" }]);
    }
  }
  if (ids.length) out.mentions = ids;
  return out;
};

/** Members who are online now (for @here). Without Redis, everyone counts as online. */
const onlineAmong = async (ids) => {
  if (!ids.length || !redisClient || redisClient.status !== "ready") return ids;
  try {
    const vals = await redisClient.mget(ids.map((id) => `presence:${id}`));
    return ids.filter((_, i) => vals[i]);
  } catch {
    return ids;
  }
};

/** Everyone a message pings: named people plus @everyone / @here, minus the sender. */
const recipientsOf = async (message, conversation) => {
  const sender = String(message.sender?._id || message.sender);
  const ids = new Set((message.mentions || []).map(String));
  if (message.mentionsAll) {
    const others = conversation.members.map((m) => String(m.user)).filter((id) => id !== sender);
    const reached = message.mentionsAll === "here" ? await onlineAmong(others) : others;
    for (const id of reached) ids.add(id);
  }
  ids.delete(sender);
  return [...ids];
};

/** States for (one person, many chats) or (many people, one chat), as a Map. */
const statesFor = async (filter, keyField) => {
  const rows = await ChatMemberState.find(filter).select("conversation user mentionCount notify mutedUntil").lean();
  return new Map(rows.map((r) => [String(r[keyField]), r]));
};

/** True when this person shouldn't be notified about this chat right now. */
const isSilenced = (state, { mentioned }, now = Date.now()) => {
  if (!state) return false;
  if (state.mutedUntil && new Date(state.mutedUntil).getTime() > now) return true;
  if (state.notify === "off") return true;
  if (state.notify === "mentions") return !mentioned;
  return false;
};

/** People with this chat open on some device right now (they see it already). */
const viewersOf = async (io, conversationId) => {
  if (!io) return new Set();
  try {
    const sockets = await io.in(`conv:${conversationId}`).fetchSockets();
    // Sockets on other servers (Redis adapter) only carry `data`
    return new Set(sockets.map((s) => String(s.data?.userId || s.user?._id || "")));
  } catch {
    return new Set();
  }
};

const chatLabel = (conversation) => (conversation.type === "group" ? conversation.name || "a group" : "a direct message");

/**
 * After a message is saved: count the mention for each person, then notify
 * them. Counting is awaited (fast, one bulk write); notifying runs after the
 * response so a big @everyone never slows the sender down.
 */
const afterMessage = async ({ message, conversation, sender, io }) => {
  if (!message.mentions?.length && !message.mentionsAll) return;
  const recipients = await recipientsOf(message, conversation);
  if (!recipients.length) return;

  const convId = conversation._id;
  await ChatMemberState.bulkWrite(
    recipients.map((user) => ({
      updateOne: {
        filter: { conversation: convId, user },
        // The tenant plugin adds orgId to the filter, so an upsert inherits it
        update: { $inc: { mentionCount: 1 } },
        upsert: true
      }
    })),
    { ordered: false }
  );

  notifyMentioned({ message, conversation, sender, io, recipients }).catch((err) =>
    logger.error(`Mention notifications failed: ${err.message}`)
  );
};

const notifyMentioned = async ({ message, conversation, sender, io, recipients }) => {
  const [states, viewing] = await Promise.all([
    statesFor({ conversation: conversation._id, user: { $in: recipients } }, "user"),
    viewersOf(io, conversation._id)
  ]);
  const to = recipients.filter((id) => !viewing.has(id) && !isSilenced(states.get(id), { mentioned: true }));
  if (!to.length) return;

  const everyone = message.mentionsAll && !(message.mentions || []).length;
  const title = "New mention";
  const text = `${sender.name} mentioned ${everyone ? `@${message.mentionsAll}` : "you"} in ${chatLabel(conversation)}`;
  const docs = await Notification.insertMany(
    to.map((recipient) => ({
      orgId: conversation.orgId,
      recipient,
      sender: sender._id,
      type: "mentioned",
      title,
      message: text,
      relatedConversation: conversation._id
    }))
  );

  const push = require("./push.service");
  for (const n of docs) {
    io?.to(`user:${n.recipient}`).emit("notification:new", n);
    if (push.configured) {
      push
        .sendToUser(n.recipient, { title, body: text, url: push.urlForNotification(n), tag: `mention:${conversation._id}` })
        .catch(() => {});
    }
  }
};

/**
 * A reply in a thread: tell the people following it (the root's author and
 * everyone who replied before), unless they're mentioned in it (they already
 * get a mention notification), only want mentions, muted the chat, or have
 * it open. Generic text, never the message.
 */
const afterThreadReply = async ({ message, root, conversation, sender, io }) => {
  const Message = require("../models/Message");
  const repliers = await Message.distinct("sender", { conversation: conversation._id, threadRoot: root._id });
  const memberIds = new Set(conversation.members.map((m) => String(m.user)));
  const pinged = new Set(await recipientsOf(message, conversation));
  const followers = [...new Set([String(root.sender), ...repliers.map(String)])].filter(
    (id) => id !== String(sender._id) && memberIds.has(id) && !pinged.has(id)
  );
  if (!followers.length) return;

  const [states, viewing] = await Promise.all([
    statesFor({ conversation: conversation._id, user: { $in: followers } }, "user"),
    viewersOf(io, conversation._id)
  ]);
  const to = followers.filter((id) => !viewing.has(id) && !isSilenced(states.get(id), { mentioned: false }));
  if (!to.length) return;

  const title = "New reply";
  const text = `${sender.name} replied in a thread in ${chatLabel(conversation)}`;
  const docs = await Notification.insertMany(
    to.map((recipient) => ({ recipient, sender: sender._id, type: "thread_reply", title, message: text, relatedConversation: conversation._id }))
  );
  const push = require("./push.service");
  for (const n of docs) {
    io?.to(`user:${n.recipient}`).emit("notification:new", n);
    if (push.configured) {
      push.sendToUser(n.recipient, { title, body: text, url: push.urlForNotification(n), tag: `thread:${root._id}` }).catch(() => {});
    }
  }
};

/** A person read the chat: their unread mentions are gone. */
const resetMentions = (conversationId, userId) =>
  ChatMemberState.updateOne({ conversation: conversationId, user: userId, mentionCount: { $gt: 0 } }, { $set: { mentionCount: 0 } });

/** Changes this person's notification choice for a chat. */
const setNotify = async ({ conversation, userId, notify, muteFor }) => {
  const update = {};
  if (notify !== undefined) {
    if (!NOTIFY_LEVELS.includes(notify)) throw new ApiError(400, "notify must be all, mentions or off");
    update.notify = notify;
  }
  if (muteFor !== undefined) {
    if (muteFor === null || muteFor === "none") update.mutedUntil = null;
    else if (Object.prototype.hasOwnProperty.call(MUTE_FOR_MS, muteFor)) {
      // "always" = until switched back; stored as a far date so one comparison covers both
      update.mutedUntil = MUTE_FOR_MS[muteFor] === null ? new Date("9999-12-31T00:00:00Z") : new Date(Date.now() + MUTE_FOR_MS[muteFor]);
    } else throw new ApiError(400, "muteFor must be 1h, 8h, 1w, always or none");
  }
  if (!Object.keys(update).length) throw new ApiError(400, "Nothing to change");
  const row = await ChatMemberState.findOneAndUpdate(
    { conversation: conversation._id, user: userId },
    { $set: update },
    { upsert: true, new: true }
  ).lean();
  return viewOf(row);
};

/** What the app shows about a person's own state in a chat. */
const viewOf = (row) => ({
  mentionCount: row?.mentionCount || 0,
  notify: row?.notify || "all",
  mutedUntil: row?.mutedUntil && new Date(row.mutedUntil).getTime() > Date.now() ? row.mutedUntil : null
});

/** Adds the viewer's own mention count and settings to a list of conversations. */
const withMyState = async (conversations, userId) => {
  if (!conversations.length) return conversations;
  const states = await statesFor(
    { user: userId, conversation: { $in: conversations.map((c) => new mongoose.Types.ObjectId(String(c._id))) } },
    "conversation"
  );
  return conversations.map((c) => ({ ...c, ...viewOf(states.get(String(c._id))) }));
};

module.exports = {
  parseMentions,
  canMentionAll,
  afterMessage,
  afterThreadReply,
  recipientsOf,
  isSilenced,
  resetMentions,
  setNotify,
  withMyState,
  statesFor,
  viewOf,
  MAX_MENTIONS
};
