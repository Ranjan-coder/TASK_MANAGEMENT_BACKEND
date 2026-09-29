const mongoose = require("mongoose");
const Conversation = require("../models/Conversation");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");

/**
 * Versioned group keys (see models/Conversation.js `groupKeyring`).
 *
 * The server never sees a group key — only copies of it wrapped for each member
 * with ECDH(wrapper private key, member public key). It enforces who may write
 * which entries:
 *   - rotate:  only a group admin, and only as the next version number
 *   - share:   any member, only for current members, and never downgrading an
 *              existing entry (a newer recipient key version may replace it)
 */

const WRAPPED_RE = /^[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;
const MAX_ENTRIES = 2000;

const isInt = (v) => Number.isInteger(v) && v >= 0 && v < 1_000_000;

const memberIds = (conversation) => new Set(conversation.members.map((m) => m.user.toString()));

const latestVersion = (conversation) =>
  conversation.groupKeyring.reduce((max, ring) => Math.max(max, ring.version), 0);

/** Validates { [userId]: { wrapped, wrapperKeyVersion, recipientKeyVersion } }. */
const parseKeyMap = (keys, allowedUserIds) => {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new ApiError(400, "keys must be an object of userId → wrapped key");
  }
  const entries = Object.entries(keys);
  if (entries.length === 0 || entries.length > 1000) throw new ApiError(400, "Invalid number of keys");

  const parsed = new Map();
  for (const [userId, entry] of entries) {
    if (!mongoose.isValidObjectId(userId) || !allowedUserIds.has(userId)) {
      throw new ApiError(400, "Keys can only be given to current members");
    }
    if (
      !entry ||
      typeof entry.wrapped !== "string" ||
      entry.wrapped.length > 512 ||
      !WRAPPED_RE.test(entry.wrapped) ||
      !isInt(entry.wrapperKeyVersion) ||
      !isInt(entry.recipientKeyVersion)
    ) {
      throw new ApiError(400, "Invalid wrapped key entry");
    }
    parsed.set(userId, {
      wrapped: entry.wrapped,
      wrapperKeyVersion: entry.wrapperKeyVersion,
      recipientKeyVersion: entry.recipientKeyVersion
    });
  }
  return parsed;
};

/** Builds version 1 of a new group's keyring (creator wraps for everyone). */
const buildInitialKeyring = ({ keys, creatorId, memberIdList }) => {
  if (!keys) return [];
  const parsed = parseKeyMap(keys, new Set(memberIdList.map(String)));
  const ring = { version: 1, createdBy: creatorId, createdAt: new Date(), keys: new Map() };
  for (const [userId, entry] of parsed) ring.keys.set(userId, { ...entry, wrappedBy: creatorId });
  return [ring];
};

const loadGroupForMember = async (conversationId, userId) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || conversation.type !== "group") throw new ApiError(404, "Group not found");
  const member = conversation.members.find((m) => m.user.toString() === userId.toString());
  if (!member) throw new ApiError(403, "You are not a member of this conversation");
  return { conversation, member };
};

/**
 * Adds a new key version (after a member is removed, or to replace a
 * compromised key). Must be exactly latest + 1 so concurrent rotations can't
 * silently overwrite each other.
 */
const rotateGroupKey = async ({ conversationId, requesterId, version, keys }) => {
  const { conversation, member } = await loadGroupForMember(conversationId, requesterId);
  if (member.role !== "admin") throw new ApiError(403, "Only group admins can rotate group keys");

  const expected = latestVersion(conversation) + 1;
  if (version !== expected) {
    throw new ApiError(409, "The group key changed in the meantime. Reload and try again.", [
      { code: "GROUP_KEY_VERSION_CONFLICT", expectedVersion: expected }
    ]);
  }

  const parsed = parseKeyMap(keys, memberIds(conversation));
  if (!parsed.has(requesterId.toString())) throw new ApiError(400, "Include a copy of the key for yourself");

  const ring = { version, createdBy: requesterId, createdAt: new Date(), keys: new Map() };
  for (const [userId, entry] of parsed) ring.keys.set(userId, { ...entry, wrappedBy: requesterId });
  conversation.groupKeyring.push(ring);
  conversation.rekeyRequested = false;
  await conversation.save();
  return conversation;
};

/**
 * Shares existing key versions with members who lack them (new members,
 * members whose key changed). entries: [{ version, userId, wrapped,
 * wrapperKeyVersion, recipientKeyVersion }]. Version 0 = legacy `groupKeys`.
 */
const shareGroupKeys = async ({ conversationId, requesterId, entries }) => {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new ApiError(400, "entries must be a non-empty list");
  }
  const { conversation, member } = await loadGroupForMember(conversationId, requesterId);
  const members = memberIds(conversation);
  const sharerId = requesterId.toString();

  // Only group admins hand keys to others (in project chats: lead/backup designer, manager).
  // Otherwise any member could plant a key of their own for someone else and cut them off.
  if (member.role !== "admin") throw new ApiError(403, "Only group admins can share chat keys", [{ code: "NOT_GROUP_ADMIN" }]);

  // A wrap must be made for the recipient's real current key
  const recipients = await User.find({ _id: { $in: [...new Set(entries.map((e) => String(e?.userId)))].filter((id) => mongoose.isValidObjectId(id)) } }).select("keyVersion");
  const currentVersion = new Map(recipients.map((u) => [String(u._id), u.keyVersion || 0]));
  let changed = 0;

  for (const e of entries) {
    const parsed = parseKeyMap({ [e?.userId]: e }, members).get(String(e?.userId));
    if (!isInt(e.version)) throw new ApiError(400, "Invalid key version");

    if (e.version === 0) {
      // Legacy map: only fill gaps, never overwrite
      if (!conversation.groupKeys.get(sharerId)) throw new ApiError(403, "You don't have this key version");
      if (!conversation.groupKeys.get(String(e.userId))) {
        conversation.groupKeys.set(String(e.userId), parsed.wrapped);
        changed++;
      }
      continue;
    }

    const ring = conversation.groupKeyring.find((r) => r.version === e.version);
    if (!ring) throw new ApiError(400, "Unknown key version");
    if (!ring.keys.get(sharerId)) throw new ApiError(403, "You don't have this key version");

    const recipientCurrent = currentVersion.get(String(e.userId));
    if (recipientCurrent === undefined || parsed.recipientKeyVersion !== recipientCurrent) {
      throw new ApiError(400, "That key isn't for the member's current device key");
    }
    // Fill a gap, replace a copy made for the member's older key, or replace a copy that an
    // ordinary member made (allowed before this check existed) — never overwrite a trusted, working one
    const existing = ring.keys.get(String(e.userId));
    const admins = new Set(conversation.members.filter((m) => m.role === "admin").map((m) => m.user.toString()));
    const trustedWrapper = existing && (String(existing.wrappedBy) === String(ring.createdBy) || admins.has(String(existing.wrappedBy)));
    if (existing && existing.recipientKeyVersion >= recipientCurrent && trustedWrapper) continue;

    ring.keys.set(String(e.userId), { ...parsed, wrappedBy: requesterId });
    changed++;
  }

  if (changed > 0) {
    conversation.markModified("groupKeyring");
    await conversation.save();
  }
  return { conversation, changed };
};

/** Removes a member's wrapped keys from every version (called on removal). */
const dropMemberKeys = (conversation, userId) => {
  const id = userId.toString();
  conversation.groupKeys.delete(id);
  for (const ring of conversation.groupKeyring) ring.keys.delete(id);
  conversation.markModified("groupKeyring");
};

/** Validates a message keyRef against the conversation. */
const parseKeyRef = (keyRef, conversation) => {
  if (keyRef === undefined || keyRef === null) return undefined;
  if (typeof keyRef !== "object" || Array.isArray(keyRef)) throw new ApiError(400, "Invalid keyRef");
  const out = {};
  for (const k of ["g", "s", "r"]) {
    if (keyRef[k] !== undefined) {
      if (!isInt(keyRef[k])) throw new ApiError(400, "Invalid keyRef");
      out[k] = keyRef[k];
    }
  }
  if (conversation.type === "group") {
    if (out.g === undefined || out.s !== undefined || out.r !== undefined) throw new ApiError(400, "Invalid keyRef");
    if (out.g > latestVersion(conversation)) throw new ApiError(400, "Unknown group key version");
  } else if (out.g !== undefined || out.s === undefined || out.r === undefined) {
    throw new ApiError(400, "Invalid keyRef");
  }
  return out;
};

/** Public key for a user at a given version (history, falling back to current). */
const getPublicKeyVersion = async (userId, version) => {
  const user = await User.findById(userId).select("+publicKeys publicKey keyVersion name");
  if (!user) throw new ApiError(404, "User not found");
  if (version === undefined || version === user.keyVersion) {
    if (!user.publicKey) throw new ApiError(404, "User has not yet set up chat encryption");
    return { user, publicKey: user.publicKey, keyVersion: user.keyVersion };
  }
  const entry = (user.publicKeys || []).find((k) => k.version === version);
  if (!entry) throw new ApiError(404, "That key version is not available");
  return { user, publicKey: entry.publicKey, keyVersion: entry.version };
};

module.exports = {
  buildInitialKeyring,
  rotateGroupKey,
  shareGroupKeys,
  dropMemberKeys,
  parseKeyRef,
  latestVersion,
  getPublicKeyVersion
};
