/**
 * Scheduled send (chat-features-plan.md P4).
 *
 *  - Scheduling runs the same checks as sending (prepareTextMessage), so a
 *    scheduled message can't do anything a normal one couldn't.
 *  - 1 minute to 30 days ahead; at most 25 waiting per person per chat.
 *  - Every minute, due messages are claimed with a lease (one server sends
 *    each, once) and posted through the normal send path. At that moment the
 *    sender must still be an active member; people mentioned who have left
 *    are dropped; if the thread root was deleted the message goes to the chat.
 */
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const ScheduledMessage = require("../models/ScheduledMessage");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const { mapLimit } = require("../utils/mapLimit");

const MIN_AHEAD_MS = 60 * 1000;
const MAX_AHEAD_MS = 30 * 24 * 3600 * 1000;
const MAX_PENDING = 25;
const MAX_MENTION_PINGS_PER_MINUTE = 10; // across all chats, like the live mention limit
const LEASE_MS = 2 * 60 * 1000;
const BATCH = 100;

const controller = () => require("../controllers/chat.controller");

/** What the app shows of a scheduled message (its own sender only). */
const view = (s) => ({
  _id: s._id,
  conversation: s.conversation,
  sendAt: s.sendAt,
  status: s.status,
  ciphertext: s.fields.ciphertext,
  iv: s.fields.iv,
  keyRef: s.fields.keyRef,
  threadRoot: s.fields.threadRoot,
  createdAt: s.createdAt
});

const schedule = async ({ conversation, sender, body }) => {
  const sendAt = new Date(body?.sendAt);
  const now = Date.now();
  if (Number.isNaN(+sendAt)) throw new ApiError(400, "Pick when to send it");
  if (+sendAt < now + MIN_AHEAD_MS - 5000) throw new ApiError(400, "Pick a time at least a minute from now");
  if (+sendAt > now + MAX_AHEAD_MS) throw new ApiError(400, "Messages can be scheduled up to 30 days ahead");
  const fields = await controller().prepareTextMessage({ conversation, sender, body });
  const pending = await ScheduledMessage.countDocuments({ sender: sender._id, conversation: conversation._id, status: "pending" });
  if (pending >= MAX_PENDING) throw new ApiError(400, `You can have ${MAX_PENDING} scheduled messages in a chat`, [{ code: "SCHEDULE_FULL" }]);
  // Mention pings can't be stacked up to all go out in the same minute (the live limit is 10 a minute)
  if (fields.mentions?.length || fields.mentionsAll) {
    const minute = new Date(Math.floor(+sendAt / 60000) * 60000);
    const sameMinute = await ScheduledMessage.countDocuments({
      sender: sender._id,
      status: "pending",
      sendAt: { $gte: minute, $lt: new Date(+minute + 60000) },
      $or: [{ "fields.mentions.0": { $exists: true } }, { "fields.mentionsAll": { $exists: true } }]
    });
    if (sameMinute >= MAX_MENTION_PINGS_PER_MINUTE) {
      throw new ApiError(400, "You already have messages with mentions going out that minute. Pick another time.", [{ code: "SCHEDULE_MENTIONS_FULL" }]);
    }
  }
  const doc = await ScheduledMessage.create({ conversation: conversation._id, sender: sender._id, sendAt, fields });
  return view(doc);
};

/** My messages waiting to be sent in this chat, soonest first. */
const listMine = async ({ conversationId, userId }) =>
  (await ScheduledMessage.find({ conversation: conversationId, sender: userId, status: "pending" }).sort({ sendAt: 1 }).limit(MAX_PENDING).lean()).map(view);

/** Cancels one of my scheduled messages (404 for anyone else's, or once it's sent). */
const cancel = async ({ id, userId }) => {
  if (!/^[a-f0-9]{24}$/i.test(String(id))) throw new ApiError(400, "Invalid id");
  const done = await ScheduledMessage.findOneAndUpdate(
    { _id: id, sender: userId, status: "pending", $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }] },
    { $set: { status: "cancelled" } },
    { new: true }
  ).lean();
  if (!done) throw new ApiError(404, "Scheduled message not found (it may have been sent already)");
  return view(done);
};

const fail = (s, error) => ScheduledMessage.updateOne({ _id: s._id }, { $set: { status: "failed", error, leaseUntil: null } });

/** Sends one due message (already claimed). */
const release = async (s) => {
  const [conversation, sender] = await Promise.all([
    Conversation.findOne({ _id: s.conversation, "members.user": s.sender }),
    User.findById(s.sender)
  ]);
  if (!conversation) return fail(s, "no longer a member");
  if (!sender || sender.status !== "active") return fail(s, "account inactive");

  const fields = { ...s.fields };
  // Things that may have changed since it was written
  const memberIds = new Set(conversation.members.map((m) => String(m.user)));
  fields.mentions = (fields.mentions || []).map(String).filter((id) => memberIds.has(id));
  if (!fields.mentions.length) fields.mentions = undefined;
  // @everyone / @here only if they may still use it (e.g. not if they stopped being a group admin)
  if (fields.mentionsAll && !require("./mention.service").canMentionAll(conversation, sender)) fields.mentionsAll = undefined;
  if (fields.threadRoot) {
    const root = await Message.exists({ _id: fields.threadRoot, conversation: conversation._id, isDeleted: false, threadRoot: null });
    if (!root) {
      fields.threadRoot = null; // root deleted: post it in the chat instead of losing it
      fields.alsoInChat = false;
    }
  }
  if (fields.replyTo && !(await Message.exists({ _id: fields.replyTo, conversation: conversation._id }))) fields.replyTo = null;

  const message = await controller().publishTextMessage({ conversation, sender, fields });
  await ScheduledMessage.updateOne({ _id: s._id }, { $set: { status: "sent", sentMessage: message._id, leaseUntil: null } });
  return message;
};

/** Every minute (per organisation): send what's due. Returns how many were sent. */
const processDue = async (now = new Date()) => {
  const due = await ScheduledMessage.find({ status: "pending", sendAt: { $lte: now } }).sort({ sendAt: 1 }).limit(BATCH).lean();
  let sent = 0;
  await mapLimit(due, 5, async (s) => {
    // Claim: still pending and not leased by another server
    const claimed = await ScheduledMessage.findOneAndUpdate(
      { _id: s._id, status: "pending", $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
      { $set: { leaseUntil: new Date(+now + LEASE_MS) } },
      { new: true }
    ).lean();
    if (!claimed) return;
    try {
      if (await release(claimed)) sent += 1;
    } catch (err) {
      logger.error(`Scheduled message ${claimed._id} failed: ${err.message}`);
      await fail(claimed, String(err.message || "error").slice(0, 200));
    }
  });
  return sent;
};

module.exports = { schedule, listMine, cancel, processDue, release, MAX_PENDING };
