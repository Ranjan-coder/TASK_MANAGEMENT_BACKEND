const chatService = require("../services/chat.service");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const { getIO } = require("../sockets");

// ── Public Key Management ────────────────────────────────────────────────────

/**
 * POST /api/v1/chat/keys/publish
 * Upload or rotate the caller's ECDH public key.
 */
const publishPublicKey = asyncHandler(async (req, res) => {
  const { publicKey } = req.body;
  if (!publicKey || typeof publicKey !== "string") {
    throw new ApiError(400, "publicKey (base64 SPKI string) is required");
  }
  // Basic length sanity check — ECDH P-256 SPKI export is ~124 bytes base64
  if (publicKey.length < 60 || publicKey.length > 256) {
    throw new ApiError(400, "Invalid public key format");
  }

  await User.findByIdAndUpdate(req.user._id, {
    publicKey,
    keyUpdatedAt: new Date(),
    $inc: { keyVersion: 1 }
  });

  res.status(200).json(new ApiResponse(200, null, "Public key published successfully"));
});

/**
 * GET /api/v1/chat/keys/:userId
 * Fetch another user's ECDH public key for DM session key derivation.
 */
const getPublicKey = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId).select("publicKey keyVersion keyUpdatedAt name");
  if (!user) throw new ApiError(404, "User not found");
  if (!user.publicKey) throw new ApiError(404, "User has not yet set up chat encryption");

  res.status(200).json(
    new ApiResponse(200, {
      userId: user._id,
      name: user.name,
      publicKey: user.publicKey,
      keyVersion: user.keyVersion,
      keyUpdatedAt: user.keyUpdatedAt
    }, "Public key retrieved")
  );
});

// ── Conversations ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/chat/conversations
 * List all conversations for the authenticated user.
 */
const getConversations = asyncHandler(async (req, res) => {
  const conversations = await chatService.getUserConversations(req.user._id);
  res.status(200).json(new ApiResponse(200, conversations, "Conversations fetched"));
});

/**
 * POST /api/v1/chat/conversations
 * Create a DM or group conversation.
 *
 * Body for DM:    { type: "dm",    memberIds: ["userId"] }
 * Body for Group: { type: "group", name: "...", memberIds: [...], encryptedGroupKeys: {...} }
 */
const createConversation = asyncHandler(async (req, res) => {
  const { type, memberIds, name, encryptedGroupKeys } = req.body;

  if (!type || !["dm", "group"].includes(type)) {
    throw new ApiError(400, "type must be 'dm' or 'group'");
  }
  if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
    throw new ApiError(400, "memberIds array is required");
  }

  let result;

  if (type === "dm") {
    if (memberIds.length !== 1) throw new ApiError(400, "DMs require exactly 1 target member");
    const target = memberIds[0];
    if (target === req.user._id.toString()) throw new ApiError(400, "Cannot DM yourself");
    result = await chatService.findOrCreateDM(req.user._id, target);
  } else {
    result = {
      conversation: await chatService.createGroup({
        name,
        creatorId: req.user._id,
        memberIds,
        encryptedGroupKeys: encryptedGroupKeys || {}
      }),
      created: true
    };
  }

  const populated = await result.conversation.populate("members.user", "name avatarUrl publicKey keyVersion");

  const statusCode = result.created ? 201 : 200;
  res.status(statusCode).json(
    new ApiResponse(statusCode, populated, result.created ? "Conversation created" : "Conversation already exists")
  );
});

/**
 * GET /api/v1/chat/conversations/:id
 * Get a single conversation (membership verified by middleware).
 */
const getConversation = asyncHandler(async (req, res) => {
  const conv = await require("../models/Conversation")
    .findById(req.params.id)
    .populate("members.user", "name avatarUrl status publicKey keyVersion")
    .populate("lastMessage", "ciphertext iv type content sender createdAt isDeleted");

  if (!conv) throw new ApiError(404, "Conversation not found");

  res.status(200).json(new ApiResponse(200, conv, "Conversation retrieved"));
});

/**
 * PATCH /api/v1/chat/conversations/:id
 * Update group name or avatar (admin only).
 */
const updateConversation = asyncHandler(async (req, res) => {
  const conv = await require("../models/Conversation").findById(req.params.id);
  if (!conv || conv.type !== "group") throw new ApiError(404, "Group not found");

  const member = conv.members.find((m) => m.user.toString() === req.user._id.toString());
  if (!member || member.role !== "admin") throw new ApiError(403, "Only group admins can update the group");

  if (req.body.name) conv.name = req.body.name.trim();
  if (req.body.avatarUrl) conv.avatarUrl = req.body.avatarUrl;
  await conv.save();

  res.status(200).json(new ApiResponse(200, conv, "Group updated"));
});

// ── Group Member Management ───────────────────────────────────────────────────

/**
 * POST /api/v1/chat/conversations/:id/members
 * Add a member to a group.
 */
const addMember = asyncHandler(async (req, res) => {
  const { userId, encryptedGroupKey } = req.body;
  if (!userId) throw new ApiError(400, "userId is required");

  const conversation = await chatService.addGroupMember({
    conversationId: req.params.id,
    requesterId: req.user._id,
    newUserId: userId,
    encryptedGroupKey
  });

  const newUser = await User.findById(userId).select("name avatarUrl publicKey keyVersion");

  // Broadcast to room
  const io = getIO();
  if (io) {
    io.to(`conv:${req.params.id}`).emit("chat:member:added", {
      conversationId: req.params.id,
      user: newUser,
      encryptedGroupKey: encryptedGroupKey || null
    });
  }

  res.status(200).json(new ApiResponse(200, conversation, "Member added"));
});

/**
 * DELETE /api/v1/chat/conversations/:id/members/:userId
 * Remove a member (or leave group).
 */
const removeMember = asyncHandler(async (req, res) => {
  const conversation = await chatService.removeGroupMember({
    conversationId: req.params.id,
    requesterId: req.user._id,
    targetUserId: req.params.userId
  });

  const io = getIO();
  if (io) {
    io.to(`conv:${req.params.id}`).emit("chat:member:removed", {
      conversationId: req.params.id,
      userId: req.params.userId
    });
    // Remove the kicked user from the socket room
    const sockets = await io.in(`conv:${req.params.id}`).fetchSockets();
    sockets
      .filter((s) => s.user?._id?.toString() === req.params.userId)
      .forEach((s) => s.leave(`conv:${req.params.id}`));
  }

  res.status(200).json(new ApiResponse(200, null, "Member removed"));
});

/**
 * PUT /api/v1/chat/conversations/:id/group-keys
 * Update encrypted group keys after re-keying (forward secrecy on member removal).
 */
const updateGroupKeys = asyncHandler(async (req, res) => {
  const { newGroupKeys } = req.body;
  if (!newGroupKeys || typeof newGroupKeys !== "object") {
    throw new ApiError(400, "newGroupKeys object is required");
  }
  const conversation = await chatService.updateGroupKeys(req.params.id, newGroupKeys, req.user._id);

  // Broadcast new keys to all remaining members
  const io = getIO();
  if (io) {
    io.to(`conv:${req.params.id}`).emit("chat:rekey", {
      conversationId: req.params.id,
      groupKeys: Object.fromEntries(conversation.groupKeys)
    });
  }

  res.status(200).json(new ApiResponse(200, null, "Group keys updated"));
});

// ── Messages ──────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/chat/conversations/:id/messages?cursor=<msgId>&limit=30
 * Fetch paginated messages (cursor-based, oldest-first display order).
 *
 * Without a cursor (initial open), returns this member's unread messages +
 * some read context above them instead of just "the last N messages" — see
 * chatService.getMessages for the full behavior.
 */
const getMessages = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 50);
  const { cursor } = req.query;

  // req.conversation is set by the requireMembership middleware on this route.
  const member = req.conversation.members.find((m) => m.user.toString() === req.user._id.toString());

  const result = await chatService.getMessages({
    conversationId: req.params.id,
    cursor,
    limit,
    userId: req.user._id,
    lastRead: member?.lastRead || null
  });

  res.status(200).json(new ApiResponse(200, result, "Messages fetched"));
});

/**
 * POST /api/v1/chat/conversations/:id/messages
 * Send a new message. Body carries ciphertext + iv (server never decrypts).
 *
 * Body: { ciphertext, iv, type?, attachments?, replyTo? }
 * For system messages: { type: "system", content: "..." }
 */
const sendMessage = asyncHandler(async (req, res) => {
  const { ciphertext, iv, type, content, attachments, replyTo } = req.body;

  // Validate: encrypted messages must have ciphertext + iv
  if (type !== "system") {
    if (!ciphertext || !iv) {
      throw new ApiError(400, "ciphertext and iv are required for encrypted messages");
    }
  }

  const message = await chatService.saveMessage({
    conversationId: req.params.id,
    senderId: req.user._id,
    type: type || "text",
    ciphertext: ciphertext || null,
    iv: iv || null,
    content: type === "system" ? content : null,
    attachments: attachments || [],
    replyTo: replyTo || null
  });

  // Broadcast to everyone in the room (including sender for echo confirmation)
  const io = getIO();
  if (io) {
    io.to(`conv:${req.params.id}`).emit("chat:message", message);
  }

  res.status(201).json(new ApiResponse(201, message, "Message sent"));
});

/**
 * PATCH /api/v1/chat/messages/:id/read
 * Mark conversation as read up to this message.
 */
const markRead = asyncHandler(async (req, res) => {
  const message = await require("../models/Message").findById(req.params.id).select("conversation");
  if (!message) throw new ApiError(404, "Message not found");

  await chatService.markAsRead(message.conversation, req.user._id);

  // Broadcast read receipt to room members
  const io = getIO();
  if (io) {
    io.to(`conv:${message.conversation}`).emit("chat:read", {
      conversationId: message.conversation,
      userId: req.user._id,
      lastRead: new Date()
    });
  }

  res.status(200).json(new ApiResponse(200, null, "Marked as read"));
});

/**
 * PATCH /api/v1/chat/messages/:id/react
 * Toggle emoji reaction on a message.
 */
const reactToMessage = asyncHandler(async (req, res) => {
  const { emoji } = req.body;
  if (!emoji) throw new ApiError(400, "emoji is required");

  const message = await chatService.toggleReaction(req.params.id, req.user._id, emoji);

  const io = getIO();
  if (io) {
    io.to(`conv:${message.conversation}`).emit("chat:reaction", {
      messageId: message._id,
      conversationId: message.conversation,
      reactions: message.reactions
    });
  }

  res.status(200).json(new ApiResponse(200, message.reactions, "Reaction updated"));
});

/**
 * DELETE /api/v1/chat/messages/:id
 * Body: { scope: "everyone" | "me" }
 *  - "everyone" (sender only): soft-deletes for all participants.
 *  - "me" (any member): hides the message from just this user's view —
 *    everyone else still sees it normally.
 */
const deleteMessage = asyncHandler(async (req, res) => {
  const scope = req.body?.scope === "me" ? "me" : "everyone";
  const io = getIO();

  if (scope === "me") {
    const message = await chatService.deleteMessageForMe(req.params.id, req.user._id);
    // Sync the hide across this user's other open tabs/devices in real time.
    if (io) {
      io.to(`user:${req.user._id}`).emit("chat:message:deletedForMe", {
        messageId: message._id,
        conversationId: message.conversation
      });
    }
    return res.status(200).json(new ApiResponse(200, null, "Message deleted for you"));
  }

  const message = await chatService.deleteMessageForEveryone(req.params.id, req.user._id);
  if (io) {
    io.to(`conv:${message.conversation}`).emit("chat:message:deleted", {
      messageId: message._id,
      conversationId: message.conversation
    });
  }

  res.status(200).json(new ApiResponse(200, null, "Message deleted"));
});

/**
 * PATCH /api/v1/chat/messages/:id/edit
 * Edit a message (sender only). Receives new ciphertext+iv of edited content.
 */
const editMessage = asyncHandler(async (req, res) => {
  const { ciphertext, iv } = req.body;
  if (!ciphertext || !iv) throw new ApiError(400, "ciphertext and iv are required");

  const message = await require("../models/Message").findOne({
    _id: req.params.id,
    sender: req.user._id,
    isDeleted: false
  });
  if (!message) throw new ApiError(403, "Cannot edit this message");

  message.ciphertext = ciphertext;
  message.iv = iv;
  message.isEdited = true;
  message.editedAt = new Date();
  await message.save();

  const io = getIO();
  if (io) {
    io.to(`conv:${message.conversation}`).emit("chat:message:edited", {
      messageId: message._id,
      conversationId: message.conversation,
      ciphertext,
      iv,
      editedAt: message.editedAt
    });
  }

  res.status(200).json(new ApiResponse(200, message, "Message edited"));
});

module.exports = {

  publishPublicKey,
  getPublicKey,
  getConversations,
  createConversation,
  getConversation,
  updateConversation,
  addMember,
  removeMember,
  updateGroupKeys,
  getMessages,
  sendMessage,
  markRead,
  reactToMessage,
  editMessage,
  deleteMessage
};
