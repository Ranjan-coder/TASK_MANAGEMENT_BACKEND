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
const { withoutMissingPeople } = require("../utils/presentPeople");

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
const mentionService = require("../services/mention.service");
const chatExtras = require("../services/chatExtras.service");
const customerChat = require("../services/customerChat.service");
const scheduled = require("../services/scheduled.service");
const { chatRooms } = require("../services/receipt.service");
const { forViewer } = require("../utils/chatPrivacy");

/**
 * Sends an event to every member of a chat: the open-chat room plus each
 * member's personal room. Socket.IO delivers once per connection even when
 * it's in several of those rooms, so nobody gets it twice.
 */
const emitToMembers = (io, conversation, event, payload) => {
  if (!io) return;
  const rooms = [`conv:${conversation._id}`, ...conversation.members.map((m) => `user:${m.user?._id || m.user}`)];
  io.to(rooms).emit(event, payload);
};

/** A thread root: a live, top-level, non-system message in this chat (one level of threads only). */
const parseThreadRoot = async (value, conversationId) => {
  if (value === undefined || value === null || value === "") return null;
  if (!isObjectId(String(value))) throw new ApiError(400, "Invalid thread");
  const root = await require("../models/Message")
    .findOne({ _id: value, conversation: conversationId })
    .select("threadRoot type isDeleted")
    .lean();
  if (!root || root.type === "system" || root.isDeleted) throw new ApiError(400, "You can only reply in threads of this chat");
  if (root.threadRoot) throw new ApiError(400, "Replies can't have their own threads", [{ code: "THREAD_NESTED" }]);
  return String(value);
};

/** After a reply in a thread (text or file): update the root, tell open screens, notify followers. */
const afterThreadReply = async ({ message, threadRoot, conversation, sender, io }) => {
  const root = await chatService.recordThreadReply(threadRoot, message);
  io?.to(`conv:${conversation._id}`).emit("chat:thread:updated", {
    conversationId: String(conversation._id),
    rootId: threadRoot,
    threadReplyCount: root.threadReplyCount,
    threadLastReplyAt: root.threadLastReplyAt,
    threadParticipants: root.threadParticipants
  });
  mentionService
    .afterThreadReply({ message, root, conversation, sender, io })
    .catch((err) => logger.error(`Thread notifications failed: ${err.message}`));
};

/**
 * GET /api/v1/chat/conversations/:id/threads/:rootId?cursor=<msgId>&limit=30
 * A thread's root and one page of replies (newest page first, oldest-first order).
 */
const getThread = asyncHandler(async (req, res) => {
  if (!isObjectId(req.params.rootId)) throw new ApiError(400, "Invalid thread");
  const cursor = typeof req.query.cursor === "string" && isObjectId(req.query.cursor) ? req.query.cursor : undefined;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 50);
  const result = await chatService.getThread({
    conversationId: req.params.id,
    rootId: req.params.rootId,
    cursor,
    limit,
    userId: req.user._id
  });
  const [root, ...messages] = await withMyStars([result.root, ...result.messages], req.user._id);
  res.status(200).json(new ApiResponse(200, { ...result, root, messages }, "Thread fetched"));
});

// Client message ids are random UUIDs made in the browser (letters, digits, dashes)
const CLIENT_MSG_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const parseClientMsgId = (v) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !CLIENT_MSG_ID_RE.test(v)) throw new ApiError(400, "Invalid clientMsgId");
  return v;
};

/** Answer a repeated send with the message already saved (only in the same chat). */
const replyWithSaved = (res, message, conversationId) => {
  if (String(message.conversation) !== String(conversationId)) {
    throw new ApiError(409, "This message id was already used in another chat", [{ code: "CLIENT_ID_REUSED" }]);
  }
  return res.status(200).json(new ApiResponse(200, message, "Message already sent"));
};

/** Project chats are managed only from Admin → Projects. */
const assertNotProject = (conversation) => {
  if (conversation?.project) {
    throw new ApiError(403, "This project chat is managed by your admins.", [{ code: "PROJECT_MANAGED" }]);
  }
  // Team notes follow their project's staff automatically (customers can never be added)
  if (conversation?.internalFor) {
    throw new ApiError(403, "Team notes follow the project team automatically.", [{ code: "PROJECT_MANAGED" }]);
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

  // Their groups' admins can now wrap the keys for this new device key: ask them now
  const io = getIO();
  if (io) {
    const groups = await require("../models/Conversation")
      .find({ type: "group", "members.user": req.user._id })
      .select("type members groupKeyring rekeyRequested")
      .populate("members.user", "publicKey")
      .limit(500)
      .lean();
    for (const g of groups) groupKeys.requestKeyHelp(io, g);
  }

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
  const conversations = await chatService.getUserConversations(req.user._id, req.user.role);
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

  // Every member must be an active account of this organisation: one scoped count
  // (another organisation's id, or one that doesn't exist, is simply not found)
  const uniqueMembers = [...new Set(memberIds.map(String))];
  if (uniqueMembers.some((id) => !/^[a-f0-9]{24}$/i.test(id))) throw new ApiError(400, "memberIds must be a list of user ids");
  const found = await User.countDocuments({ _id: { $in: uniqueMembers }, status: "active", deletedAt: null });
  if (found !== uniqueMembers.length) {
    throw new ApiError(400, "Some of these people can't be added to a chat.", [{ code: "MEMBER_NOT_FOUND" }]);
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

  const populated = withoutMissingPeople(await result.conversation.populate("members.user", "name avatarUrl publicKey keyVersion"));

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

  const [withState] = await mentionService.withMyState([forViewer(withoutMissingPeople(conv), req.user._id, req.user.role)], req.user._id);
  res.status(200).json(new ApiResponse(200, withState, "Conversation retrieved"));
});

/**
 * PATCH /api/v1/chat/conversations/:id/notify  { notify?: all|mentions|off, muteFor?: 1h|8h|1w|always|none }
 * This person's own notification choice for the chat (nobody else sees it).
 */
const updateNotify = asyncHandler(async (req, res) => {
  const state = await mentionService.setNotify({
    conversation: req.conversation,
    userId: req.user._id,
    notify: req.body?.notify,
    muteFor: req.body?.muteFor
  });
  // The person's other tabs and devices update their bell too
  getIO()?.to(`user:${req.user._id}`).emit("chat:notify", { conversationId: req.params.id, ...state });
  res.status(200).json(new ApiResponse(200, state, "Notification settings saved"));
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
    // No key handed over with the add (e.g. they hadn't set up chat): the admins' apps share it later
    groupKeys.requestKeyHelp(io, conversation);
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
    io.in(`user:${req.params.userId}`).socketsLeave(chatRooms(req.params.id));
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
  const { cursor, around, after } = req.query;
  for (const v of [cursor, around, after]) {
    if (v !== undefined && !isObjectId(v)) throw new ApiError(400, "Invalid cursor");
  }

  let result;
  if (around) {
    // Jump to a message (search, star, pin, older mention)
    result = await chatService.getMessagesAround({ conversationId: req.params.id, aroundId: around, limit, userId: req.user._id });
  } else if (after) {
    // Newer page after a jump
    result = await chatService.getMessagesAfter({ conversationId: req.params.id, afterId: after, limit, userId: req.user._id });
  } else {
    // req.conversation is set by the requireMembership middleware on this route.
    const member = req.conversation.members.find((m) => m.user.toString() === req.user._id.toString());
    result = await chatService.getMessages({
      conversationId: req.params.id,
      cursor,
      limit,
      userId: req.user._id,
      lastRead: member?.lastRead || null
    });
  }
  result.messages = await withMyStars(result.messages, req.user._id);
  res.status(200).json(new ApiResponse(200, result, "Messages fetched"));
});

/** Marks which messages the viewer starred (★), one query per page. */
const withMyStars = async (messages, userId) => {
  const starred = await chatExtras.starredAmong(userId, messages.map((m) => m._id));
  return messages.map((m) => (starred.has(String(m._id)) ? { ...m, starred: true } : m));
};

// ── Pins and stars (chat-features-plan.md CH-P) ──────────────────────────────

const getPins = asyncHandler(async (req, res) => {
  const pins = await chatExtras.listPins({ conversationId: req.params.id, userId: req.user._id });
  res.status(200).json(new ApiResponse(200, { pins, canPin: chatExtras.canPin(req.conversation, req.user) }));
});

const changePin = (action) =>
  asyncHandler(async (req, res) => {
    const pins = await chatExtras[action]({ conversation: req.conversation, user: req.user, messageId: req.params.msgId });
    getIO()?.to(`conv:${req.params.id}`).emit("chat:pins:updated", { conversationId: req.params.id, pins });
    res.status(200).json(new ApiResponse(200, { pins }));
  });
const pinMessage = changePin("pin");
const unpinMessage = changePin("unpin");

const starMessage = asyncHandler(async (req, res) => {
  await chatExtras.star({ userId: req.user._id, messageId: req.params.id });
  getIO()?.to(`user:${req.user._id}`).emit("chat:starred", { messageId: req.params.id, starred: true });
  res.status(200).json(new ApiResponse(200, { starred: true }));
});

const unstarMessage = asyncHandler(async (req, res) => {
  await chatExtras.unstar({ userId: req.user._id, messageId: req.params.id });
  getIO()?.to(`user:${req.user._id}`).emit("chat:starred", { messageId: req.params.id, starred: false });
  res.status(200).json(new ApiResponse(200, { starred: false }));
});

// ── Customer experience (P4) ─────────────────────────────────────────────────

/** GET /conversations/:id/service-info: the project chat banner (open now, hours, typical reply time). */
const getServiceInfo = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await customerChat.serviceInfo(req.conversation)));
});

/** POST /conversations/:id/team-notes { encryptedGroupKeys? }: open or start the staff-only notes chat. */
const openTeamNotes = asyncHandler(async (req, res) => {
  const result = await customerChat.openTeamNotes({ project: req.conversation, user: req.user, encryptedGroupKeys: req.body?.encryptedGroupKeys });
  if (result.created) {
    const notes = await require("../models/Conversation")
      .findById(result.conversationId)
      .populate("members.user", "name avatarUrl status publicKey keyVersion");
    const io = getIO();
    for (const m of notes.members) io?.to(`user:${m.user._id}`).emit("conversation:created", withoutMissingPeople(notes));
    groupKeys.requestKeyHelp(io, notes); // teammates who hadn't set up chat yet get the key later
  }
  res.status(result.created ? 201 : 200).json(new ApiResponse(result.created ? 201 : 200, result));
});

/** GET /conversations/:id/files?kind=image|doc|audio&cursor= */
const getFiles = asyncHandler(async (req, res) => {
  const kind = typeof req.query.kind === "string" ? req.query.kind : "image";
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  res.status(200).json(new ApiResponse(200, await chatExtras.listFiles({ conversationId: req.params.id, userId: req.user._id, kind, cursor })));
});

/** POST /conversations/:id/scheduled { …same as a message…, sendAt } */
const scheduleMessage = asyncHandler(async (req, res) => {
  const item = await scheduled.schedule({ conversation: req.conversation, sender: req.user, body: req.body });
  res.status(201).json(new ApiResponse(201, item, "Message scheduled"));
});

const listScheduled = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await scheduled.listMine({ conversationId: req.params.id, userId: req.user._id })));
});

const cancelScheduled = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await scheduled.cancel({ id: req.params.sid, userId: req.user._id }), "Scheduled message cancelled"));
});

const getStarred = asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 50);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  res.status(200).json(new ApiResponse(200, await chatExtras.listStarred({ userId: req.user._id, cursor, limit })));
});

/**
 * POST /api/v1/chat/conversations/:id/messages
 * Send a new message. Body carries ciphertext + iv (server never decrypts).
 *
 * Body: { ciphertext, iv, type?, attachments?, replyTo? }
 * For system messages: { type: "system", content: "..." }
 */
/**
 * Checks an encrypted text message and returns the fields to store. Used when
 * it's sent and when it's scheduled (scheduled.service.js), so both follow the
 * same rules. Throws 400/403 for anything not allowed.
 */
const prepareTextMessage = async ({ conversation, sender, body }) => {
  const { ciphertext, iv, type, attachments, replyTo, keyRef, franking, moderation } = body || {};
  // System messages are created only by the server (never by clients), so a
  // member can't post fake notices in plain text.
  if ((type || "text") !== "text") throw new ApiError(400, "Send files through the attachment upload");
  if (attachments && attachments.length) throw new ApiError(400, "Send files through the attachment upload");
  await assertReplyInConversation(replyTo, String(conversation._id));
  if (!ciphertext || !iv || typeof ciphertext !== "string" || typeof iv !== "string") {
    throw new ApiError(400, "ciphertext and iv are required for encrypted messages");
  }
  if (ciphertext.length > 200_000 || iv.length > 64) throw new ApiError(400, "Message is too long");

  // Project chats: text must carry a franking commitment so it can be reported with proof
  const commitment = franking?.commitment;
  const frankOk = Boolean(stampFranking({ commitment, conversationId: String(conversation._id), senderId: String(sender._id) }));
  if (conversation.project && !frankOk) {
    throw new ApiError(400, "This chat needs an updated app. Please reload the page.", [{ code: "FRANKING_REQUIRED" }]);
  }

  // Who the (encrypted) text mentions, as plain ids the app lists (CH-D1)
  const { mentions, mentionsAll } = mentionService.parseMentions(body, { conversation, sender });
  // A reply in a thread (CH-T): the root must be a live, top-level message of this chat
  const threadRoot = await parseThreadRoot(body.threadRoot, String(conversation._id));
  if (body.alsoInChat !== undefined && typeof body.alsoInChat !== "boolean") throw new ApiError(400, "Invalid alsoInChat");
  // "Forwarded" label (P4). Customers can't forward (keeps project content in its chat).
  if (body.forwarded !== undefined && typeof body.forwarded !== "boolean") throw new ApiError(400, "Invalid forwarded");
  if (body.forwarded && sender.role === ROLES.CUSTOMER) throw new ApiError(403, "Customers can't forward messages");

  return {
    ciphertext,
    iv,
    replyTo: replyTo || null,
    keyRef: groupKeys.parseKeyRef(keyRef, conversation),
    commitment: frankOk ? commitment : undefined,
    moderation: moderationService.parseModeration(moderation, { messageType: "text", conversation }),
    mentions,
    mentionsAll,
    threadRoot,
    alsoInChat: Boolean(threadRoot && body.alsoInChat),
    forwarded: body.forwarded ? true : undefined
  };
};

/**
 * Saves a checked text message and does everything a new message triggers:
 * live delivery to members, thread updates, reply timers, abuse counts,
 * mentions. The franking stamp carries the time it's actually sent.
 */
const publishTextMessage = async ({ conversation, sender, fields, clientMsgId }) => {
  const franking = fields.commitment
    ? stampFranking({ commitment: fields.commitment, conversationId: String(conversation._id), senderId: String(sender._id) })
    : undefined;
  const message = await chatService.saveMessage({
    conversationId: conversation._id,
    senderId: sender._id,
    type: "text",
    ciphertext: fields.ciphertext,
    iv: fields.iv,
    content: null,
    attachments: [],
    replyTo: fields.replyTo,
    keyRef: fields.keyRef,
    franking,
    moderation: fields.moderation,
    clientMsgId,
    mentions: fields.mentions,
    mentionsAll: fields.mentionsAll,
    threadRoot: fields.threadRoot,
    alsoInChat: fields.alsoInChat,
    forwarded: fields.forwarded
  });

  // To every member (sidebar previews, unread and mention badges), including the sender's other tabs
  const io = getIO();
  emitToMembers(io, conversation, "chat:message", message);

  // Thread reply: the root's "N replies" updates on open screens; followers are told
  if (fields.threadRoot) await afterThreadReply({ message, threadRoot: fields.threadRoot, conversation, sender, io });

  // Project chats: start or stop the reply timer; count abuse flags; count and
  // notify mentions (never fail the send). Independent: run them together.
  const hooks = [
    require("../services/sla.service").onMessage({ conversation, sender }),
    require("../services/offlineAlerts.service").onStaffMessage({ conversation, sender }),
    mentionService.afterMessage({ message, conversation, sender, io })
  ];
  if (conversation.project) {
    hooks.push(
      moderationService.afterTextMessage({
        conversation,
        sender,
        newHits: message.moderation?.hitCount || 0,
        severity: message.moderation?.severity
      })
    );
  }
  const settled = await Promise.allSettled(hooks);
  for (const s of settled) if (s.status === "rejected") logger.error(`sendMessage hook failed: ${s.reason?.message}`);
  return message;
};

const sendMessage = asyncHandler(async (req, res) => {
  const clientMsgId = parseClientMsgId(req.body.clientMsgId);

  // A retry of a message that already reached us: hand back the saved copy
  // (no second broadcast, no hooks), so a flaky network never sends it twice.
  if (clientMsgId) {
    const existing = await chatService.findByClientMsgId(req.user._id, clientMsgId);
    if (existing) return replyWithSaved(res, existing, req.params.id);
  }

  const fields = await prepareTextMessage({ conversation: req.conversation, sender: req.user, body: req.body });
  let message;
  try {
    message = await publishTextMessage({ conversation: req.conversation, sender: req.user, fields, clientMsgId });
  } catch (err) {
    // Two copies of the same retry raced: the unique index let one in
    if (err?.code === 11000 && clientMsgId) {
      const existing = await chatService.findByClientMsgId(req.user._id, clientMsgId);
      if (existing) return replyWithSaved(res, existing, req.params.id);
    }
    throw err;
  }
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

  // Receipts go to the chat's open screens from markAsRead (team vs customer view, CH-D3)
  await chatService.markAsRead(message.conversation, req.user._id);

  // My other tabs and devices clear their unread badge
  getIO()?.to(`user:${req.user._id}`).emit("chat:read", {
    conversationId: message.conversation,
    userId: req.user._id,
    lastRead: new Date()
  });

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
  // A deleted message doesn't stay pinned
  const pinsChanged = (await chatExtras.unpinDeleted(message.conversation, message._id)).modifiedCount > 0;
  if (io) {
    io.to(`conv:${message.conversation}`).emit("chat:message:deleted", {
      messageId: message._id,
      conversationId: message.conversation
    });
    if (pinsChanged) io.to(`conv:${message.conversation}`).emit("chat:pins:updated", { conversationId: String(message.conversation) });
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
  parseThreadRoot,
  afterThreadReply,
  prepareTextMessage,
  publishTextMessage,

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
  updateNotify,
  addMember,
  removeMember,
  updateGroupKeys,
  getMessages,
  getThread,
  getPins,
  pinMessage,
  unpinMessage,
  starMessage,
  unstarMessage,
  getStarred,
  getServiceInfo,
  openTeamNotes,
  getFiles,
  scheduleMessage,
  listScheduled,
  cancelScheduled,
  sendMessage,
  markRead,
  reactToMessage,
  editMessage,
  deleteMessage
};
