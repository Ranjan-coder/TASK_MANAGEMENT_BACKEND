const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const redisClient = require("../config/redis");

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
  if (!name || !name.trim()) throw new ApiError(400, "Group name is required");

  // Deduplicate and ensure creator is included
  const uniqueIds = [...new Set([creatorId.toString(), ...memberIds.map(String)])];
  if (uniqueIds.length < 2) throw new ApiError(400, "A group needs at least 2 members");

  const members = uniqueIds.map((uid) => ({
    user: uid,
    role: uid === creatorId.toString() ? "admin" : "member"
  }));

  // encryptedGroupKeys: { [userId]: base64EncodedEncryptedKey }
  const groupKeys = new Map(Object.entries(encryptedGroupKeys || {}));

  const conversation = await Conversation.create({
    type: "group",
    name: name.trim(),
    createdBy: creatorId,
    members,
    groupKeys
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
const getUserConversations = async (userId) => {
  const conversations = await Conversation.find({
    "members.user": userId,
    isArchived: false
  })
    .sort({ lastActivityAt: -1 })
    .populate("lastMessage", "ciphertext iv type content sender createdAt isDeleted")
    .populate("members.user", "name avatarUrl status publicKey keyVersion")
    .lean();

  // Compute unread count per conversation
  const withUnread = await Promise.all(
    conversations.map(async (conv) => {
      const member = conv.members.find((m) => m.user._id.toString() === userId.toString());
      const lastRead = member?.lastRead || new Date(0);

      const unreadCount = await Message.countDocuments({
        conversation: conv._id,
        createdAt: { $gt: lastRead },
        sender: { $ne: userId },
        isDeleted: false
      });

      // Attach online presence from Redis
      const memberIds = conv.members.map((m) => m.user._id.toString());
      const onlineStatuses = await Promise.all(
        memberIds.map(async (uid) => {
          if (!redisClient || redisClient.status !== "ready") return false;
          const val = await redisClient.get(`presence:${uid}`);
          return !!val;
        })
      );

      conv.members = conv.members.map((m, i) => ({
        ...m,
        isOnline: onlineStatuses[i] || false
      }));

      return { ...conv, unreadCount };
    })
  );

  return withUnread;
};

// ── Message helpers ──────────────────────────────────────────────────────────

/**
 * Save a new message (server only stores ciphertext + iv — never plaintext).
 */
const saveMessage = async ({ conversationId, senderId, type, ciphertext, iv, content, attachments, replyTo }) => {
  const message = await Message.create({
    conversation: conversationId,
    sender: senderId,
    type: type || "text",
    ciphertext: ciphertext || null,
    iv: iv || null,
    content: type === "system" ? content : null, // only plain for system messages
    attachments: attachments || [],
    replyTo: replyTo || null
  });

  // Update conversation's lastMessage + lastActivityAt
  await Conversation.findByIdAndUpdate(conversationId, {
    lastMessage: message._id,
    lastActivityAt: message.createdAt
  });

  return message.populate("sender", "name avatarUrl");
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

  return { items: docs, hasMore, nextCursor: hasMore && docs.length > 0 ? docs[0]._id : null };
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

/**
 * Mark a conversation as read for a user (updates lastRead timestamp).
 */
const markAsRead = async (conversationId, userId) => {
  await Conversation.updateOne(
    { _id: conversationId, "members.user": userId },
    { $set: { "members.$.lastRead": new Date() } }
  );
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
const addGroupMember = async ({ conversationId, requesterId, newUserId, encryptedGroupKey }) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || conversation.type !== "group") throw new ApiError(404, "Group not found");

  const requester = conversation.members.find((m) => m.user.toString() === requesterId.toString());
  if (!requester || requester.role !== "admin") throw new ApiError(403, "Only group admins can add members");

  const alreadyMember = conversation.members.some((m) => m.user.toString() === newUserId.toString());
  if (alreadyMember) throw new ApiError(409, "User is already a member");

  conversation.members.push({ user: newUserId, role: "member" });
  if (encryptedGroupKey) {
    conversation.groupKeys.set(newUserId.toString(), encryptedGroupKey);
  }
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
  conversation.groupKeys.delete(targetUserId.toString());

  if (conversation.members.length === 0) {
    conversation.isArchived = true;
  }

  await conversation.save();
  return conversation;
};

/**
 * Update group keys after re-keying (called after member removal for forward secrecy).
 * newGroupKeys: { [userId]: base64EncryptedKey }
 */
const updateGroupKeys = async (conversationId, newGroupKeys, requesterId) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new ApiError(404, "Conversation not found");

  const requester = conversation.members.find((m) => m.user.toString() === requesterId.toString());
  if (!requester || requester.role !== "admin") throw new ApiError(403, "Only admins can rotate group keys");

  for (const [uid, encKey] of Object.entries(newGroupKeys)) {
    conversation.groupKeys.set(uid, encKey);
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
  getMessages,
  markAsRead,
  toggleReaction,
  deleteMessageForEveryone,
  deleteMessageForMe,
  addGroupMember,
  removeGroupMember,
  updateGroupKeys
};
