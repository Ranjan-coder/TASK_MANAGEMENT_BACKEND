/**
 * Pins and stars (chat-features-plan.md CH-P).
 *
 *  - Pins belong to the chat (everyone sees them), at most 50, newest first.
 *    DMs: either person. Groups: group admins. Project chats: staff, never
 *    customers.
 *  - Stars are private: a person's own saved messages, from chats they're
 *    still in. Only ids are stored; the text stays encrypted.
 */
const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const StarredMessage = require("../models/StarredMessage");
const { ROLES } = require("../config/roles");
const { withSender } = require("../utils/presentPeople");

const MAX_PINS = 50;
const isObjectId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
const POPULATE_SENDER = ["sender", "name avatarUrl"];
const POPULATE_REPLY = ["replyTo", "ciphertext iv type content sender createdAt isDeleted"];

/** May this person pin and unpin in this chat? */
const canPin = (conversation, user) => {
  if (user.role === ROLES.CUSTOMER) return false;
  if (conversation.type === "dm" || conversation.project) return true;
  const me = conversation.members.find((m) => String(m.user?._id || m.user) === String(user._id));
  return me?.role === "admin";
};

const assertCanPin = (conversation, user) => {
  if (!canPin(conversation, user)) throw new ApiError(403, "You can't pin messages in this chat", [{ code: "PIN_DENIED" }]);
};

/** Pins a message of this chat (shown in the chat itself, not deleted, not a system notice). */
const pin = async ({ conversation, user, messageId }) => {
  assertCanPin(conversation, user);
  if (!isObjectId(messageId)) throw new ApiError(400, "Invalid message");
  const msg = await Message.findOne({ _id: messageId, conversation: conversation._id }).select("type isDeleted threadRoot alsoInChat").lean();
  if (!msg || msg.isDeleted || msg.type === "system") throw new ApiError(404, "Message not found");
  if (msg.threadRoot && !msg.alsoInChat) throw new ApiError(400, "Replies inside a thread can't be pinned");

  // One atomic update: not already pinned, and fewer than MAX_PINS (no read-then-write race)
  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id, "pins.message": { $ne: msg._id }, [`pins.${MAX_PINS - 1}`]: { $exists: false } },
    { $push: { pins: { $each: [{ message: msg._id, by: user._id, at: new Date() }], $position: 0 } } },
    { new: true, projection: { pins: 1 } }
  ).lean();
  if (updated) return updated.pins;
  const current = await Conversation.findById(conversation._id).select("pins").lean();
  if ((current?.pins || []).some((p) => String(p.message) === String(msg._id))) return current.pins; // already pinned
  throw new ApiError(400, `A chat can have at most ${MAX_PINS} pinned messages. Unpin one first.`, [{ code: "PINS_FULL" }]);
};

const unpin = async ({ conversation, user, messageId }) => {
  assertCanPin(conversation, user);
  if (!isObjectId(messageId)) throw new ApiError(400, "Invalid message");
  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id },
    { $pull: { pins: { message: new mongoose.Types.ObjectId(messageId) } } },
    { new: true, projection: { pins: 1 } }
  ).lean();
  return updated?.pins || [];
};

/** Drops a message from the pins (it was deleted for everyone). */
const unpinDeleted = (conversationId, messageId) =>
  Conversation.updateOne({ _id: conversationId }, { $pull: { pins: { message: messageId } } });

/** The pinned messages (encrypted), in pin order, with who pinned them and when. */
const listPins = async ({ conversationId, userId }) => {
  const conv = await Conversation.findById(conversationId).select("pins").lean();
  const pins = conv?.pins || [];
  if (!pins.length) return [];
  const msgs = await Message.find({ _id: { $in: pins.map((p) => p.message) }, conversation: conversationId, deletedFor: { $ne: userId } })
    .populate(...POPULATE_SENDER)
    .populate(...POPULATE_REPLY)
    .lean();
  const byId = new Map(msgs.map((m) => [String(m._id), withSender(m)]));
  return pins.filter((p) => byId.has(String(p.message))).map((p) => ({ by: p.by, at: p.at, message: byId.get(String(p.message)) }));
};

// ── Stars ────────────────────────────────────────────────────────────────────

/** Message the person can see (member of its chat, not deleted for them); 404 otherwise. */
const visibleMessage = async (messageId, userId) => {
  if (!isObjectId(messageId)) throw new ApiError(400, "Invalid message");
  const msg = await Message.findOne({ _id: messageId, deletedFor: { $ne: userId } }).select("conversation type").lean();
  // Same answer for "doesn't exist" and "not your chat": ids of other chats stay hidden
  const member = msg && (await Conversation.exists({ _id: msg.conversation, "members.user": userId }));
  if (!msg || !member || msg.type === "system") throw new ApiError(404, "Message not found");
  return msg;
};

const star = async ({ userId, messageId }) => {
  const msg = await visibleMessage(messageId, userId);
  await StarredMessage.updateOne(
    { user: userId, message: msg._id },
    { $setOnInsert: { conversation: msg.conversation } },
    { upsert: true }
  );
};

const unstar = async ({ userId, messageId }) => {
  if (!isObjectId(messageId)) throw new ApiError(400, "Invalid message");
  await StarredMessage.deleteOne({ user: userId, message: messageId });
};

/** Which of these messages this person starred (for the ☆/★ in lists). */
const starredAmong = async (userId, messageIds) => {
  if (!messageIds.length) return new Set();
  const rows = await StarredMessage.find({ user: userId, message: { $in: messageIds } }).select("message").lean();
  return new Set(rows.map((r) => String(r.message)));
};

/**
 * A person's starred messages, newest star first, keyset-paged. Chats they've
 * left and messages deleted for them are skipped (the star stays in case they
 * come back, but nothing of it is shown).
 */
const listStarred = async ({ userId, cursor, limit = 30 }) => {
  const filter = { user: userId };
  if (cursor) {
    if (!isObjectId(cursor)) throw new ApiError(400, "Invalid cursor");
    filter._id = { $lt: new mongoose.Types.ObjectId(cursor) };
  }
  const stars = await StarredMessage.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = stars.length > limit;
  if (hasMore) stars.pop();
  const convIds = [...new Set(stars.map((s) => String(s.conversation)))];
  const stillIn = new Set(
    (await Conversation.find({ _id: { $in: convIds }, "members.user": userId }).select("_id").lean()).map((c) => String(c._id))
  );
  const msgs = await Message.find({
    _id: { $in: stars.filter((s) => stillIn.has(String(s.conversation))).map((s) => s.message) },
    deletedFor: { $ne: userId }
  })
    .populate(...POPULATE_SENDER)
    .lean();
  const byId = new Map(msgs.map((m) => [String(m._id), withSender(m)]));
  return {
    items: stars
      .filter((s) => byId.has(String(s.message)))
      .map((s) => ({ starredAt: s.createdAt, message: { ...byId.get(String(s.message)), starred: true } })),
    next: hasMore ? String(stars[stars.length - 1]._id) : null
  };
};

// ── Shared files (P4) ────────────────────────────────────────────────────────

const FILE_KINDS = {
  image: { "attachments.fileType": "image" },
  audio: { "attachments.fileType": "audio" },
  doc: { "attachments.fileType": { $nin: ["image", "audio"] } }
};

/**
 * Files shared in a chat, newest first, one kind at a time, keyset-paged by
 * time. Metadata only (name, type, size); the files stay encrypted and are
 * opened by the app with the chat's keys.
 */
const listFiles = async ({ conversationId, userId, kind = "image", cursor, limit = 30 }) => {
  const filter = FILE_KINDS[kind];
  if (!filter) throw new ApiError(400, "kind must be image, doc or audio");
  const query = { conversation: conversationId, "attachments.0": { $exists: true }, isDeleted: false, deletedFor: { $ne: userId }, ...filter };
  if (cursor) {
    if (!isObjectId(cursor)) throw new ApiError(400, "Invalid cursor");
    const at = await Message.findOne({ _id: cursor, conversation: conversationId }).select("createdAt").lean();
    if (at) query.createdAt = { $lt: at.createdAt };
  }
  const docs = await Message.find(query)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .select("conversation sender type attachments keyRef createdAt threadRoot")
    .populate(...POPULATE_SENDER)
    .lean();
  const hasMore = docs.length > limit;
  if (hasMore) docs.pop();
  return { messages: docs.map(withSender), next: hasMore && docs.length ? String(docs[docs.length - 1]._id) : null };
};

module.exports = { canPin, pin, unpin, unpinDeleted, listPins, star, unstar, starredAmong, listStarred, listFiles, MAX_PINS };
