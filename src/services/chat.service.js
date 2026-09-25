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

/**
 * Get paginated messages for a conversation (cursor-based, descending).
 */
const getMessages = async ({ conversationId, cursor, limit = 30 }) => {
  const query = {
    conversation: conversationId
  };

  // If cursor is provided, fetch messages older than that message's createdAt
  if (cursor) {
    const cursorMessage = await Message.findById(cursor).select("createdAt").lean();
    if (cursorMessage) {
      query.createdAt = { $lt: cursorMessage.createdAt };
    }
  }

  const messages = await Message.find(query)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .populate("sender", "name avatarUrl")
    .populate("replyTo", "ciphertext iv type content sender createdAt isDeleted")
    .lean();

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  // Return in chronological order for the client
  messages.reverse();

  const nextCursor = hasMore && messages.length > 0 ? messages[0]._id : null;

  return { messages, hasMore, nextCursor };
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

/**
 * Soft-delete a message. Only sender can delete their own messages.
 */
const deleteMessage = async (messageId, userId) => {
  const message = await Message.findOne({ _id: messageId, sender: userId });
  if (!message) throw new ApiError(403, "Cannot delete this message");
  message.isDeleted = true;
  message.ciphertext = null;
  message.iv = null;
  message.attachments = [];
  await message.save();
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
  deleteMessage,
  addGroupMember,
  removeGroupMember,
  updateGroupKeys
};
