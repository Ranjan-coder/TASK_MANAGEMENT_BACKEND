const chatService = require("../services/chat.service");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const { getIO } = require("../sockets");
const { ROLES, ADMIN_ROLES } = require("../config/roles");
const groupKeys = require("../services/groupKeys.service");
const { stampFranking } = require("../utils/franking");
const mongoose = require("mongoose");
const logger = require("../utils/logger");

const isObjectId = (v) => typeof v === "string" && mongoose.isValidObjectId(v) && /^[a-f0-9]{24}$/i.test(v);
// One emoji (with skin tone / ZWJ sequences / flags), nothing else
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\p{Emoji_Modifier}|\u200D(?:\p{Extended_Pictographic})|\p{Regional_Indicator})*$/u;
const MAX_DISTINCT_REACTIONS = 20;
const PROJECT_EDIT_WINDOW_MS = 15 * 60 * 1000;

/** A reply must point at a message in the same chat (otherwise it would reveal another chat's message). */
const assertReplyInConversation = async (replyTo, conversationId) => {
  if (replyTo === undefined || replyTo === null || replyTo === "") return;
  if (!isObjectId(String(replyTo))) throw new ApiError(400, "Invalid reply");
  const ok = await require("../models/Message").exists({ _id: replyTo, conversation: conversationId });
  if (!ok) throw new ApiError(400, "You can only reply to messages in this chat");
};
const moderationService = require("../services/moderation.service");

/** Project chats are managed only from Admin → Projects. */
const assertNotProject = (conversation) => {
  if (conversation?.project) {
    throw new ApiError(403, "This project chat is managed by Bonito admins.", [{ code: "PROJECT_MANAGED" }]);
  }
};

/**
 * Customers may only be placed in group chats by an admin/superadmin, and never
 * in direct messages (they chat only inside project groups Bonito sets up).
 */
const assertCustomerPlacementAllowed = async ({ actor, userIds, type }) => {
  const ids = [...new Set(userIds.map(String))];
  const customerCount = await User.countDocuments({ _id: { $in: ids }, role: ROLES.CUSTOMER });
  if (customerCount === 0) return;
  if (type === "dm") {
    throw new ApiError(403, "Direct messages with customers are not allowed. Use a project group.");
  }
  if (!ADMIN_ROLES.includes(actor.role)) {
    throw new ApiError(403, "Only admins can add customers to a chat");
  }
};

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
  // Basic sanity check — ECDH P-256 SPKI export is ~124 bytes base64
  if (publicKey.length < 60 || publicKey.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) {
    throw new ApiError(400, "Invalid public key format");
  }

  const user = await User.findById(req.user._id).select("+publicKeys publicKey keyVersion");
  if (user.publicKey === publicKey) {
    return res.status(200).json(new ApiResponse(200, { keyVersion: user.keyVersion }, "Public key already published"));
  }

  // Keep every published key so messages encrypted with older keys stay readable
  const history = user.publicKeys || [];
  if (user.publicKey && !history.some((k) => k.version === user.keyVersion)) {
    history.push({ version: user.keyVersion, publicKey: user.publicKey, createdAt: user.keyUpdatedAt || new Date() });
  }
  const keyVersion = (user.keyVersion || 0) + 1;
  history.push({ version: keyVersion, publicKey, createdAt: new Date() });

  user.publicKeys = history;
  user.publicKey = publicKey;
  user.keyVersion = keyVersion;
  user.keyUpdatedAt = new Date();
  await user.save({ validateBeforeSave: false });

  res.status(200).json(new ApiResponse(200, { keyVersion }, "Public key published successfully"));
});

/**
 * GET /api/v1/chat/keys/:userId[?version=N]
 * A user's ECDH public key — the current one, or an older version for
 * decrypting messages sent before they changed keys.
 */
const getPublicKey = asyncHandler(async (req, res) => {
  const version = req.query.version !== undefined ? Number(req.query.version) : undefined;
  if (version !== undefined && (!Number.isInteger(version) || version < 0)) {
    throw new ApiError(400, "Invalid key version");
  }
  const { user, publicKey, keyVersion } = await groupKeys.getPublicKeyVersion(req.params.userId, version);

  res.status(200).json(
    new ApiResponse(200, {
      userId: user._id,
      name: user.name,
      publicKey,
      keyVersion,
      currentKeyVersion: user.keyVersion,
      keyUpdatedAt: user.keyUpdatedAt
    }, "Public key retrieved")
  );
});

/**
 * GET /api/v1/chat/keys/bundle
 * The caller's own encrypted private-key bundle (the server can't decrypt it).
 */
const getKeyBundle = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("+keyBundle +recoveryBundle publicKey keyVersion");
  res.status(200).json(
    new ApiResponse(200, {
      bundle: user.keyBundle?.ciphertext
        ? { ciphertext: user.keyBundle.ciphertext, iv: user.keyBundle.iv, version: user.keyBundle.version }
        : null,
      publicKey: user.publicKey || null,
      keyVersion: user.keyVersion || 0,
      recoveryAvailable: Boolean(user.recoveryBundle?.ciphertext),
      recoveryUpdatedAt: user.recoveryBundle?.updatedAt || null
    })
  );
});

/**
 * PUT /api/v1/chat/keys/bundle  { ciphertext, iv, expectedVersion }
 * Replaces the caller's bundle. expectedVersion (0 when none exists) stops two
 * devices from overwriting each other's newly added keys.
 */
const putKeyBundle = asyncHandler(async (req, res) => {
  const { ciphertext, iv, expectedVersion, recovery } = req.body || {};
  const isSealed = (b) =>
    b &&
    typeof b.ciphertext === "string" &&
    b.ciphertext.length >= 16 &&
    b.ciphertext.length <= 200000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(b.ciphertext) &&
    typeof b.iv === "string" &&
    /^[A-Za-z0-9+/]{16}$/.test(b.iv);
  if (recovery !== undefined && !isSealed(recovery)) {
    throw new ApiError(400, "Invalid recovery bundle");
  }
  if (
    typeof ciphertext !== "string" ||
    ciphertext.length < 16 ||
    ciphertext.length > 200000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) ||
    typeof iv !== "string" ||
    !/^[A-Za-z0-9+/]{16}$/.test(iv) ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    throw new ApiError(400, "Invalid key bundle");
  }

  const current = await User.findById(req.user._id).select("+keyBundle mustChangePassword");
  if (current.mustChangePassword) {
    throw new ApiError(403, "Change your password before setting up chat keys.");
  }
  const currentVersion = current.keyBundle?.version || 0;
  if (currentVersion !== expectedVersion) {
    throw new ApiError(409, "Your chat keys changed on another device. Reload and try again.", [
      { code: "KEY_BUNDLE_VERSION_CONFLICT", currentVersion }
    ]);
  }

  const version = currentVersion + 1;
  const filter = { _id: req.user._id };
  if (currentVersion === 0) filter["keyBundle.version"] = { $exists: false };
  else filter["keyBundle.version"] = currentVersion;

  const $set = { keyBundle: { ciphertext, iv, version, updatedAt: new Date() } };
  // Copy of the same keys sealed with the recovery key (kept in sync by the client)
  if (recovery) $set.recoveryBundle = { ciphertext: recovery.ciphertext, iv: recovery.iv, updatedAt: new Date() };

  const updated = await User.findOneAndUpdate(filter, { $set }, { new: true });
  if (!updated) {
    throw new ApiError(409, "Your chat keys changed on another device. Reload and try again.", [
      { code: "KEY_BUNDLE_VERSION_CONFLICT" }
    ]);
  }

  res.status(200).json(new ApiResponse(200, { version }, "Chat keys saved"));
});

/**
 * GET /api/v1/chat/keys/recovery
 * The recovery copy of the caller's keys — only openable with the recovery key
 * the user saved (256-bit, so it can't be guessed).
 */
const getRecoveryBundle = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("+recoveryBundle");
  if (!user.recoveryBundle?.ciphertext) throw new ApiError(404, "No recovery key has been set up");
  res.status(200).json(
    new ApiResponse(200, { ciphertext: user.recoveryBundle.ciphertext, iv: user.recoveryBundle.iv })
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
  if (memberIds.length > 256 || !memberIds.every((id) => typeof id === "string")) {
    throw new ApiError(400, "memberIds must be a list of user ids");
  }

  await assertCustomerPlacementAllowed({ actor: req.user, userIds: memberIds, type });

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

  assertNotProject(conv);
  const member = conv.members.find((m) => m.user.toString() === req.user._id.toString());
  if (!member || member.role !== "admin") throw new ApiError(403, "Only group admins can update the group");

  if (typeof req.body.name === "string" && req.body.name.trim()) conv.name = req.body.name.trim().slice(0, 100);
  if (req.body.avatarUrl !== undefined) {
    const url = String(req.body.avatarUrl || "");
    if (url && !/^https:\/\/[^\s"'<>]+$/.test(url)) throw new ApiError(400, "Group picture must be an https link");
    conv.avatarUrl = url || null;
  }
  await conv.save();

  res.status(200).json(new ApiResponse(200, conv, "Group updated"));
});

// ── Group Member Management ───────────────────────────────────────────────────

/**
 * POST /api/v1/chat/conversations/:id/members
 * Add a member to a group.
 */
const addMember = asyncHandler(async (req, res) => {
  const { userId, groupKeyEntries } = req.body;
  if (!userId || typeof userId !== "string") throw new ApiError(400, "userId is required");
  assertNotProject(req.conversation);

  await assertCustomerPlacementAllowed({ actor: req.user, userIds: [userId], type: "group" });

  let conversation = await chatService.addGroupMember({
    conversationId: req.params.id,
    requesterId: req.user._id,
    newUserId: userId
  });

  // Give the new member the existing key versions (so they can read history)
  if (Array.isArray(groupKeyEntries) && groupKeyEntries.length > 0) {
    ({ conversation } = await groupKeys.shareGroupKeys({
      conversationId: req.params.id,
      requesterId: req.user._id,
      entries: groupKeyEntries.map((e) => ({ ...e, userId }))
    }));
  }

  const newUser = await User.findById(userId).select("name avatarUrl publicKey keyVersion");

  // Broadcast to room
  const io = getIO();
  if (io) {
    io.to(`conv:${req.params.id}`).emit("chat:member:added", {
      conversationId: req.params.id,
      user: newUser,
      groupKeyring: conversation.groupKeyring
    });
  }

  res.status(200).json(new ApiResponse(200, conversation, "Member added"));
});

/**
 * DELETE /api/v1/chat/conversations/:id/members/:userId
 * Remove a member (or leave group).
 */
const removeMember = asyncHandler(async (req, res) => {
  assertNotProject(req.conversation);
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
    // Remove the kicked user's live connections from the room so they stop
    // receiving new messages (every socket joins its user's own room)
    io.in(`user:${req.params.userId}`).socketsLeave(`conv:${req.params.id}`);
  }

  res.status(200).json(new ApiResponse(200, null, "Member removed"));
});

/**
 * PUT /api/v1/chat/conversations/:id/group-keys
 * Update encrypted group keys after re-keying (forward secrecy on member removal).
 */
const updateGroupKeys = asyncHandler(async (req, res) => {
  const { version, keys } = req.body || {};
  if (!Number.isInteger(version)) throw new ApiError(400, "version is required");

  const conversation = await groupKeys.rotateGroupKey({
    conversationId: req.params.id,
    requesterId: req.user._id,
    version,
    keys
  });

  // Broadcast the new key version (wrapped copies only) to the room
  const io = getIO();
  if (io) {
    io.to(`conv:${req.params.id}`).emit("chat:rekey", {
      conversationId: req.params.id,
      groupKeyring: conversation.groupKeyring
    });
  }

  res.status(200).json(new ApiResponse(200, { version }, "Group key rotated"));
});

/**
 * POST /api/v1/chat/conversations/:id/group-keys/share  { entries: [...] }
 * Any member can give existing key versions to members who lack them.
 */
const shareGroupKeys = asyncHandler(async (req, res) => {
  const { conversation, changed } = await groupKeys.shareGroupKeys({
    conversationId: req.params.id,
    requesterId: req.user._id,
    entries: req.body?.entries
  });

  if (changed > 0) {
    const io = getIO();
    if (io) {
      io.to(`conv:${req.params.id}`).emit("chat:rekey", {
        conversationId: req.params.id,
        groupKeyring: conversation.groupKeyring,
        groupKeys: Object.fromEntries(conversation.groupKeys)
      });
    }
  }

  res.status(200).json(new ApiResponse(200, { changed }, "Group keys shared"));
});

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
  const { ciphertext, iv, type, attachments, replyTo, keyRef, franking, moderation } = req.body;

  // System messages are created only by the server (never by clients), so a
  // member can't post fake notices in plain text.
  const messageType = type || "text";
  if (messageType !== "text") {
    throw new ApiError(400, "Send files through the attachment upload");
  }
  if (attachments && attachments.length) throw new ApiError(400, "Send files through the attachment upload");
  await assertReplyInConversation(replyTo, req.params.id);
  if (!ciphertext || !iv) {
    throw new ApiError(400, "ciphertext and iv are required for encrypted messages");
  }

  // Project chats: text must carry a franking commitment so it can be reported with proof
  const frankingRecord =
    messageType === "text"
      ? stampFranking({ commitment: franking?.commitment, conversationId: String(req.params.id), senderId: String(req.user._id) })
      : undefined;
  if (req.conversation.project && messageType === "text" && !frankingRecord) {
    throw new ApiError(400, "This chat needs an updated app. Please reload the page.", [{ code: "FRANKING_REQUIRED" }]);
  }

  const message = await chatService.saveMessage({
    conversationId: req.params.id,
    senderId: req.user._id,
    type: messageType,
    ciphertext,
    iv,
    content: null,
    attachments: attachments || [],
    replyTo: replyTo || null,
    keyRef: groupKeys.parseKeyRef(keyRef, req.conversation),
    franking: frankingRecord,
    moderation: moderationService.parseModeration(moderation, { messageType, conversation: req.conversation })
  });

  // Broadcast to everyone in the room (including sender for echo confirmation)
  const io = getIO();
  if (io) {
    io.to(`conv:${req.params.id}`).emit("chat:message", message);
  }

  // Project chats: start or stop the reply timer; count abuse flags (never fail the send)
  // The three hooks are independent: run them together (latency = slowest, not the sum).
  const hooks = [
    require("../services/sla.service").onMessage({ conversation: req.conversation, sender: req.user }),
    require("../services/offlineAlerts.service").onStaffMessage({ conversation: req.conversation, sender: req.user })
  ];
  if (messageType === "text" && req.conversation.project) {
    hooks.push(
      moderationService.afterTextMessage({
        conversation: req.conversation,
        sender: req.user,
        newHits: message.moderation?.hitCount || 0,
        severity: message.moderation?.severity
      })
    );
  }
  const settled = await Promise.allSettled(hooks);
  for (const s of settled) if (s.status === "rejected") logger.error(`sendMessage hook failed: ${s.reason?.message}`);

  res.status(201).json(new ApiResponse(201, message, "Message sent"));
});

/**
 * PATCH /api/v1/chat/messages/:id/read
 * Mark conversation as read up to this message.
 */
const markRead = asyncHandler(async (req, res) => {
  if (!isObjectId(req.params.id)) throw new ApiError(400, "Invalid id");
  const message = await require("../models/Message").findById(req.params.id).select("conversation");
  if (!message) throw new ApiError(404, "Message not found");
  await chatService.assertMembership(message.conversation, req.user._id);

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
  if (typeof emoji !== "string" || !EMOJI_RE.test(emoji)) throw new ApiError(400, "Pick an emoji");
  if (!isObjectId(req.params.id)) throw new ApiError(400, "Invalid id");
  const target = await require("../models/Message").findById(req.params.id).select("conversation reactions type");
  if (!target || target.type === "system") throw new ApiError(404, "Message not found");
  await chatService.assertMembership(target.conversation, req.user._id);
  if (!target.reactions.some((r) => r.emoji === emoji) && target.reactions.length >= MAX_DISTINCT_REACTIONS) {
    throw new ApiError(400, "This message has too many different reactions");
  }

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

  // Customers cannot erase messages for everyone — keeps evidence intact for reports
  if (req.user.role === ROLES.CUSTOMER) {
    throw new ApiError(403, "Customers can only delete messages for themselves");
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
  const { ciphertext, iv, keyRef, franking, moderation } = req.body;
  if (!ciphertext || !iv) throw new ApiError(400, "ciphertext and iv are required");

  const message = await require("../models/Message").findOne({
    _id: req.params.id,
    sender: req.user._id,
    isDeleted: false
  });
  if (!message) throw new ApiError(403, "Cannot edit this message");
  if (message.type !== "text") throw new ApiError(400, "Only text messages can be edited");

  const conversation = await require("../models/Conversation").findById(message.conversation);
  if (!conversation?.members.some((m) => String(m.user) === String(req.user._id))) {
    throw new ApiError(403, "You are not a member of this conversation");
  }
  // Project chats are a record: edits only shortly after sending, so a message can't be quietly rewritten later
  if (conversation.project && Date.now() - message.createdAt.getTime() > PROJECT_EDIT_WINDOW_MS) {
    throw new ApiError(403, "Messages in project chats can only be edited within 15 minutes of sending");
  }
  if (await require("../services/projectExtras.service").hasApproval(message._id)) {
    throw new ApiError(409, "This message has a design approval, so it can't be edited");
  }
  const frankingRecord =
    message.type === "text"
      ? stampFranking({ commitment: franking?.commitment, conversationId: String(message.conversation), senderId: String(req.user._id) })
      : undefined;
  if (conversation?.project && message.type === "text" && !frankingRecord) {
    throw new ApiError(400, "This chat needs an updated app. Please reload the page.", [{ code: "FRANKING_REQUIRED" }]);
  }
  if (conversation?.project) {
    await require("../models/MessageEvidence").create({
      message: message._id,
      conversation: message.conversation,
      sender: message.sender,
      reason: "edited",
      ciphertext: message.ciphertext,
      iv: message.iv,
      keyRef: message.keyRef,
      franking: message.franking,
      originalCreatedAt: message.createdAt,
      actor: req.user._id
    });
  }
  message.ciphertext = ciphertext;
  message.iv = iv;
  if (keyRef !== undefined) message.keyRef = groupKeys.parseKeyRef(keyRef, conversation);
  // Edits are checked again; removing words never lowers the earlier count
  const newFlag = moderationService.parseModeration(moderation, { messageType: message.type, conversation });
  const oldHits = message.moderation?.hitCount || 0;
  const addedHits = newFlag && newFlag.hitCount > oldHits ? newFlag.hitCount - oldHits : 0;
  if (addedHits) {
    const rank = { mild: 1, abusive: 2, threat: 3 };
    const severity = rank[newFlag.severity] >= (rank[message.moderation?.severity] || 0) ? newFlag.severity : message.moderation.severity;
    message.moderation = { flagged: true, severity, hitCount: newFlag.hitCount };
  }
  message.franking = frankingRecord;
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
      keyRef: message.keyRef,
      franking: message.franking ? { commitment: message.franking.commitment } : undefined,
      editedAt: message.editedAt
    });
  }

  if (addedHits && conversation?.project) {
    await moderationService.afterTextMessage({ conversation, sender: req.user, newHits: addedHits, severity: newFlag.severity, isEdit: true });
  }

  res.status(200).json(new ApiResponse(200, message, "Message edited"));
});

module.exports = {
  assertReplyInConversation,

  publishPublicKey,
  getPublicKey,
  getKeyBundle,
  putKeyBundle,
  getRecoveryBundle,
  shareGroupKeys,
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
