const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const redisClient = require("../config/redis");
const mongoose = require("mongoose");
const { withSender } = require("../utils/presentPeople");

/** Messages shown in the chat itself: everything except thread-only replies (CH-T). */
const MAIN_TIMELINE = { $or: [{ threadRoot: null }, { alsoInChat: true }] };

// ── Conversation helpers ────────────────────────────────────────────────────

/**
 * Find or create a DM conversation between two users.
 * Idempotent — returns existing conv if it already exists.
 */
const findOrCreateDM = async (userId, targetUserId) => {
  const existing = await Conversation.findOne({
    type: "dm",
    "members.user": { $all: [userId, targetUserId] }
  });

  if (existing) return { conversation: existing, created: false };

  const conversation = await Conversation.create({
    type: "dm",
    createdBy: userId,
    members: [
      { user: userId, role: "admin" },
      { user: targetUserId, role: "admin" }
    ]
  });

  return { conversation, created: true };
};

/**
 * Create a new group conversation.
 */
const createGroup = async ({ name, creatorId, memberIds, encryptedGroupKeys }) => {
  const { buildInitialKeyring } = require("./groupKeys.service");
  if (!name || !name.trim()) throw new ApiError(400, "Group name is required");

  // Deduplicate and ensure creator is included
  const uniqueIds = [...new Set([creatorId.toString(), ...memberIds.map(String)])];
  if (uniqueIds.length < 2) throw new ApiError(400, "A group needs at least 2 members");

  const members = uniqueIds.map((uid) => ({
    user: uid,
    role: uid === creatorId.toString() ? "admin" : "member"
  }));

  // encryptedGroupKeys: { [userId]: { wrapped, wrapperKeyVersion, recipientKeyVersion } } → key version 1
  const groupKeyring = buildInitialKeyring({ keys: encryptedGroupKeys, creatorId, memberIdList: uniqueIds });

  const conversation = await Conversation.create({
    type: "group",
    name: name.trim(),
    createdBy: creatorId,
    members,
    groupKeyring
  });

  return conversation;
};

/**
 * Verify that a user is a member of a conversation.
 * Throws 403 if not.
 */
const assertMembership = async (conversationId, userId) => {
  const conversation = await Conversation.findOne({
    _id: conversationId,
    "members.user": userId
  });
  if (!conversation) throw new ApiError(403, "You are not a member of this conversation");
  return conversation;
};

/**
 * Get all conversations for a user, with unread counts.
 * Sorted by lastActivityAt descending (most recent first).
 */
const getUserConversations = async (userId, viewerRole) => {
  const conversations = await Conversation.find({
    "members.user": userId,
    isArchived: false
  })
    .sort({ lastActivityAt: -1 })
    .populate("lastMessage", "ciphertext iv type content sender createdAt isDeleted")
    .populate("members.user", "name avatarUrl status publicKey keyVersion")
    .lean();

  if (!conversations.length) return [];
  const me = userId.toString();

  // Unread counts for every conversation in ONE aggregation (was one countDocuments
  // per conversation). Each $or branch is served by the {conversation, createdAt} index.
  const branches = conversations.map((conv) => {
    const member = conv.members.find((m) => m.user && m.user._id.toString() === me);
    return { conversation: conv._id, createdAt: { $gt: member?.lastRead || new Date(0) } };
  });
  const counts = await Message.aggregate([
    // Thread-only replies aren't unread in the chat itself (followers get a notification)
    { $match: { $and: [{ $or: branches }, MAIN_TIMELINE], sender: { $ne: new mongoose.Types.ObjectId(me) }, isDeleted: false } },
    { $group: { _id: "$conversation", n: { $sum: 1 } } }
  ]);
  const unreadBy = new Map(counts.map((c) => [c._id.toString(), c.n]));

  // Presence for every distinct member in ONE Redis round trip (was one GET per member per chat).
  const online = new Set();
  if (redisClient && redisClient.status === "ready") {
    const ids = [...new Set(conversations.flatMap((c) => c.members.filter((m) => m.user).map((m) => m.user._id.toString())))];
    try {
      const vals = await redisClient.mget(ids.map((id) => `presence:${id}`));
      vals.forEach((v, i) => { if (v) online.add(ids[i]); });
    } catch { /* presence is best-effort */ }
  }

  const { forViewer } = require("../utils/chatPrivacy");
  const list = conversations.map((conv) =>
    // Customers see the team's read state, not each person's (CH-D3)
    forViewer(
      {
        ...conv,
        // Members whose account is gone are left out (populate returns null for them)
        members: conv.members.filter((m) => m.user).map((m) => ({ ...m, isOnline: online.has(m.user._id.toString()) })),
        unreadCount: unreadBy.get(conv._id.toString()) || 0
      },
      userId,
      viewerRole
    )
  );
  // My unread mentions and notification settings (one query for all chats)
  return require("./mention.service").withMyState(list, userId);
};

// ── Message helpers ──────────────────────────────────────────────────────────

/**
 * Save a new message (server only stores ciphertext + iv — never plaintext).
 */
const saveMessage = async ({ conversationId, senderId, type, ciphertext, iv, content, attachments, replyTo, keyRef, franking, moderation, clientMsgId, mentions, mentionsAll, threadRoot, alsoInChat, forwarded }) => {
  const message = await Message.create({
    clientMsgId,
    forwarded,
    mentions,
    mentionsAll,
    threadRoot: threadRoot || null,
    alsoInChat: threadRoot && alsoInChat ? true : undefined,
    conversation: conversationId,
    sender: senderId,
    type: type || "text",
    ciphertext: ciphertext || null,
    iv: iv || null,
    content: type === "system" ? content : null, // only plain for system messages
    attachments: attachments || [],
    replyTo: replyTo || null,
    keyRef,
    franking,
    moderation
  });

  // Update conversation's lastMessage + lastActivityAt (a thread-only reply leaves the chat's preview alone)
  if (!threadRoot || alsoInChat) {
    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: message._id,
      lastActivityAt: message.createdAt
    });
  }

  return message.populate("sender", "name avatarUrl");
};

const MAX_THREAD_PARTICIPANTS_SHOWN = 5;

/**
 * A reply arrived in a thread: bump the root's count and last-reply time, and
 * add the sender to the faces shown (first 5 people). Atomic updates, so
 * replies arriving at the same time are all counted.
 */
const recordThreadReply = async (rootId, message) => {
  const sender = message.sender?._id || message.sender;
  await Message.updateOne(
    { _id: rootId },
    { $inc: { threadReplyCount: 1 }, $max: { threadLastReplyAt: message.createdAt } }
  );
  await Message.updateOne(
    { _id: rootId, threadParticipants: { $ne: sender }, [`threadParticipants.${MAX_THREAD_PARTICIPANTS_SHOWN - 1}`]: { $exists: false } },
    { $push: { threadParticipants: sender } }
  );
  return Message.findById(rootId).select("conversation sender threadReplyCount threadLastReplyAt threadParticipants").lean();
};

/** A thread's root plus one page of its replies (cursor pages back in time, like the chat). */
const getThread = async ({ conversationId, rootId, cursor, limit = 30, userId }) => {
  const root = await Message.findOne({ _id: rootId, conversation: conversationId, deletedFor: { $ne: userId } })
    .populate("sender", "name avatarUrl")
    .populate("replyTo", "ciphertext iv type content sender createdAt isDeleted")
    .lean();
  if (!root || root.threadRoot) throw new ApiError(404, "Thread not found");
  const base = { conversation: conversationId, threadRoot: rootId, deletedFor: { $ne: userId } };
  let query = base;
  if (cursor) {
    const at = await Message.findOne({ _id: cursor, ...base }).select("createdAt").lean();
    if (at) query = { ...base, createdAt: { $lt: at.createdAt } };
  }
  const { items, hasMore, nextCursor } = await fetchDescPage(query, limit);
  return { root: withSender(root), messages: items, hasMore, nextCursor };
};

/** A sender's message by the id their app gave it (idempotent retries); null if none. */
const findByClientMsgId = async (senderId, clientMsgId) => {
  const message = await Message.findOne({ sender: senderId, clientMsgId });
  return message ? message.populate("sender", "name avatarUrl") : null;
};

// Initial-load tuning for the unread-first view (see getMessages below).
const UNREAD_CONTEXT_COUNT = 20; // already-read messages shown for context above the unread ones
const UNREAD_INITIAL_CAP = 50; // cap so a huge backlog isn't dumped in one response

/**
 * Fetch one descending, limit-bounded page and flip it back to chronological
 * order. Shared by both the cursor-pagination path and the initial-load path
 * below so neither ever loads more than `limit + 1` documents.
 */
const fetchDescPage = async (query, limit) => {
  const docs = await Message.find(query)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .populate("sender", "name avatarUrl")
    .populate("replyTo", "ciphertext iv type content sender createdAt isDeleted")
    .lean();

  const hasMore = docs.length > limit;
  if (hasMore) docs.pop();
  docs.reverse(); // oldest -> newest, the order the client renders in

  // Messages from an account that's gone keep showing, as "Deleted user"
  const items = docs.map(withSender);
  return { items, hasMore, nextCursor: hasMore && items.length > 0 ? items[0]._id : null };
};

/**
 * Get messages for a conversation.
 *
 * - With a cursor: plain backward pagination (unchanged) — fetches the next
 *   older page, bounded by `limit`. Used for "load previous messages".
 * - Without a cursor (initial open): returns this member's unread messages
 *   (capped at UNREAD_INITIAL_CAP, most recent first if there's a huge
 *   backlog) plus up to UNREAD_CONTEXT_COUNT already-read messages
 *   immediately before them for context, so the view isn't just a bare list
 *   starting mid-conversation. `unreadMarkerId` tells the client which
 *   message starts the unread section so it can render a divider there and
 *   scroll straight to it. If nothing is unread, falls back to the plain
 *   "most recent page" behavior (today's default) with no marker.
 *
 * Either way, the response never contains more than a bounded number of
 * documents, and older history stays reachable exclusively via `nextCursor`
 * — the server never loads (and the client never receives) a whole
 * conversation's history at once.
 */
const getMessages = async ({ conversationId, cursor, limit = 30, userId, lastRead }) => {
  const baseQuery = {
    ...MAIN_TIMELINE,
    conversation: conversationId,
    // Exclude messages this user has "deleted for me" — they should never
    // see them again, regardless of what other members can still see.
    deletedFor: { $ne: userId }
  };

  // ── Backward pagination ("load previous messages") — unchanged ──────────
  if (cursor) {
    const cursorMessage = await Message.findById(cursor).select("createdAt").lean();
    const query = cursorMessage ? { ...baseQuery, createdAt: { $lt: cursorMessage.createdAt } } : baseQuery;
    const { items, hasMore, nextCursor } = await fetchDescPage(query, limit);
    return { messages: items, hasMore, nextCursor, unreadMarkerId: null };
  }

  // ── Initial load: unread-first ───────────────────────────────────────────
  const unread = lastRead
    ? (
        await fetchDescPage(
          { ...baseQuery, createdAt: { $gt: lastRead }, sender: { $ne: userId } },
          UNREAD_INITIAL_CAP
        )
      ).items
    : [];

  if (unread.length === 0) {
    // Nothing unread — fall back to the plain "most recent page" view.
    const { items, hasMore, nextCursor } = await fetchDescPage(baseQuery, limit);
    return { messages: items, hasMore, nextCursor, unreadMarkerId: null };
  }

  // Context: already-read messages immediately preceding the unread window.
  const { items: context, hasMore, nextCursor } = await fetchDescPage(
    { ...baseQuery, createdAt: { $lt: unread[0].createdAt } },
    UNREAD_CONTEXT_COUNT
  );

  return {
    messages: [...context, ...unread],
    hasMore,
    nextCursor,
    unreadMarkerId: unread[0]._id
  };
};

/** Newer messages after `fromMsg` (by createdAt, then _id), oldest first: one page plus "is there more". */
const fetchAscPage = async (base, fromMsg, limit) => {
  const docs = await Message.find({
    $and: [base, { $or: [{ createdAt: { $gt: fromMsg.createdAt } }, { createdAt: fromMsg.createdAt, _id: { $gt: fromMsg._id } }] }]
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit + 1)
    .populate("sender", "name avatarUrl")
    .populate("replyTo", "ciphertext iv type content sender createdAt isDeleted")
    .lean();
  const hasNewer = docs.length > limit;
  if (hasNewer) docs.pop();
  const items = docs.map(withSender);
  return { items, hasNewer, newerCursor: hasNewer && items.length ? items[items.length - 1]._id : null };
};

/**
 * Jump to a message (search result, star, pin, old mention): the message
 * with up to limit/2 messages either side. If it's a reply inside a thread,
 * only its root is reported, so the app opens the thread instead.
 */
const getMessagesAround = async ({ conversationId, aroundId, limit = 30, userId }) => {
  const target = await Message.findOne({ _id: aroundId, conversation: conversationId, deletedFor: { $ne: userId } })
    .populate("sender", "name avatarUrl")
    .populate("replyTo", "ciphertext iv type content sender createdAt isDeleted")
    .lean();
  if (!target) throw new ApiError(404, "Message not found");
  if (target.threadRoot && !target.alsoInChat) return { threadRoot: target.threadRoot, messages: [], hasMore: false, nextCursor: null, hasNewer: false, newerCursor: null };

  const base = { ...MAIN_TIMELINE, conversation: conversationId, deletedFor: { $ne: userId } };
  const half = Math.max(5, Math.floor(limit / 2));
  const [older, newer] = await Promise.all([
    fetchDescPage({ $and: [base, { $or: [{ createdAt: { $lt: target.createdAt } }, { createdAt: target.createdAt, _id: { $lt: target._id } }] }] }, half),
    fetchAscPage(base, target, half)
  ]);
  return {
    messages: [...older.items, withSender(target), ...newer.items],
    hasMore: older.hasMore,
    nextCursor: older.nextCursor,
    hasNewer: newer.hasNewer,
    newerCursor: newer.newerCursor
  };
};

/** The page after a message (scrolling down after a jump). */
const getMessagesAfter = async ({ conversationId, afterId, limit = 30, userId }) => {
  const from = await Message.findOne({ _id: afterId, conversation: conversationId }).select("createdAt").lean();
  if (!from) throw new ApiError(404, "Message not found");
  const base = { ...MAIN_TIMELINE, conversation: conversationId, deletedFor: { $ne: userId } };
  const { items, hasNewer, newerCursor } = await fetchAscPage(base, from, limit);
  return { messages: items, hasNewer, newerCursor };
};

/**
 * Mark a conversation as read for a user (updates lastRead timestamp).
 */
const markAsRead = async (conversationId, userId) => {
  // lastRead (and lastDelivered) move forward only; the chat's open screens get the receipt (CH-R)
  await Promise.all([
    require("./receipt.service").markRead(require("../sockets").getIO(), conversationId, userId),
    require("./mention.service").resetMentions(conversationId, userId)
  ]);
};

/**
 * Toggle an emoji reaction on a message.
 */
const toggleReaction = async (messageId, userId, emoji) => {
  const message = await Message.findById(messageId);
  if (!message) throw new ApiError(404, "Message not found");

  const reaction = message.reactions.find((r) => r.emoji === emoji);
  if (reaction) {
    const idx = reaction.users.findIndex((u) => u.toString() === userId.toString());
    if (idx >= 0) {
      reaction.users.splice(idx, 1); // un-react
      if (reaction.users.length === 0) {
        message.reactions = message.reactions.filter((r) => r.emoji !== emoji);
      }
    } else {
      reaction.users.push(userId); // add reaction
    }
  } else {
    message.reactions.push({ emoji, users: [userId] }); // new reaction
  }

  await message.save();
  return message;
};

// "Delete for everyone" is only allowed within this window of sending — keep
// in sync with DELETE_FOR_EVERYONE_WINDOW_MS in the frontend's MessageBubble.
const DELETE_FOR_EVERYONE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Soft-delete a message for everyone. Only the sender can do this, and only
 * within 10 minutes of sending — enforced here as the source of truth
 * (the frontend also hides the option once expired, but that's UX only).
 */
const deleteMessageForEveryone = async (messageId, userId) => {
  const message = await Message.findOne({ _id: messageId, sender: userId });
  if (!message) throw new ApiError(403, "Cannot delete this message");

  const ageMs = Date.now() - message.createdAt.getTime();
  if (ageMs > DELETE_FOR_EVERYONE_WINDOW_MS) {
    throw new ApiError(403, "Messages can only be deleted for everyone within 10 minutes of sending");
  }

  // A design sign-off must stay checkable
  if (await require("./projectExtras.service").hasApproval(message._id)) {
    throw new ApiError(409, "This design has an approval request, so it can't be deleted");
  }

  // Project chats: keep the original (still encrypted) for report reviews
  const conv = await Conversation.findById(message.conversation).select("project");
  if (conv?.project) {
    await require("../models/MessageEvidence").create({
      message: message._id,
      conversation: message.conversation,
      sender: message.sender,
      reason: "deleted",
      ciphertext: message.ciphertext,
      iv: message.iv,
      keyRef: message.keyRef,
      franking: message.franking,
      attachments: message.attachments,
      originalCreatedAt: message.createdAt,
      actor: userId
    });
  }

  message.isDeleted = true;
  message.ciphertext = null;
  message.iv = null;
  message.attachments = [];
  await message.save();
  return message;
};

/**
 * Hide a message from just this user's view ("delete for me"). The message
 * is untouched for every other participant. Any conversation member may do
 * this to any message, including ones they didn't send.
 */
const deleteMessageForMe = async (messageId, userId) => {
  const message = await Message.findById(messageId);
  if (!message) throw new ApiError(404, "Message not found");

  const conv = await Conversation.findOne({ _id: message.conversation, "members.user": userId });
  if (!conv) throw new ApiError(403, "You are not a member of this conversation");

  await Message.updateOne({ _id: messageId }, { $addToSet: { deletedFor: userId } });
  return message;
};

// ── Group management ─────────────────────────────────────────────────────────

/**
 * Add a member to a group (admin only). Caller must provide the new
 * member's encrypted group key copy.
 */
const addGroupMember = async ({ conversationId, requesterId, newUserId }) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || conversation.type !== "group") throw new ApiError(404, "Group not found");

  const requester = conversation.members.find((m) => m.user.toString() === requesterId.toString());
  if (!requester || requester.role !== "admin") throw new ApiError(403, "Only group admins can add members");

  const alreadyMember = conversation.members.some((m) => m.user.toString() === newUserId.toString());
  if (alreadyMember) throw new ApiError(409, "User is already a member");

  conversation.members.push({ user: newUserId, role: "member" });
  await conversation.save();
  return conversation;
};

/**
 * Remove a member from a group (admin only, or self-leave).
 * Re-keying (forward secrecy) is handled by the client after receiving the event.
 */
const removeGroupMember = async ({ conversationId, requesterId, targetUserId }) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || conversation.type !== "group") throw new ApiError(404, "Group not found");

  const requester = conversation.members.find((m) => m.user.toString() === requesterId.toString());
  const isSelf = requesterId.toString() === targetUserId.toString();

  if (!isSelf && (!requester || requester.role !== "admin")) {
    throw new ApiError(403, "Only group admins can remove members");
  }

  conversation.members = conversation.members.filter((m) => m.user.toString() !== targetUserId.toString());
  require("./groupKeys.service").dropMemberKeys(conversation, targetUserId);

  if (conversation.members.length === 0) {
    conversation.isArchived = true;
  }

  await conversation.save();
  return conversation;
};

module.exports = {
  findOrCreateDM,
  createGroup,
  assertMembership,
  getUserConversations,
  saveMessage,
  recordThreadReply,
  getThread,
  getMessagesAround,
  getMessagesAfter,
  findByClientMsgId,
  getMessages,
  markAsRead,
  toggleReaction,
  deleteMessageForEveryone,
  deleteMessageForMe,
  addGroupMember,
  removeGroupMember
};
