/**
 * Delivered / read receipts (chat-features-plan.md CH-R).
 *
 * No write per message per reader: each member has two timestamps,
 * lastDelivered and lastRead, moved forward with $max (atomic, so events that
 * arrive late or twice can't move them back). The apps work out the ticks of
 * each message from these times.
 *
 * Who hears about it (decision CH-D3): sockets that open a chat join
 * `conv:<id>:team` (staff) or `conv:<id>:cust` (customers of a project chat).
 * The team gets everyone's times; customers only hear "the team got / saw it
 * at T", never who, and nothing about other customers.
 */
const Conversation = require("../models/Conversation");
const { isProjectCustomer } = require("../utils/chatPrivacy");

const teamRoom = (id) => `conv:${id}:team`;
const customerRoom = (id) => `conv:${id}:cust`;
/** Every room a socket may be in for one chat (leave them all when someone is removed). */
const chatRooms = (id) => [`conv:${id}`, teamRoom(id), customerRoom(id)];

/** Moves this member's times forward. Returns the conversation (project customers only) or null if not a member. */
const advance = async (conversationId, userId, { lastRead, lastDelivered }) => {
  const $max = {};
  if (lastRead) $max["members.$.lastRead"] = lastRead;
  // Read implies received
  const delivered = lastDelivered && lastRead ? (lastDelivered > lastRead ? lastDelivered : lastRead) : lastDelivered || lastRead;
  if (delivered) $max["members.$.lastDelivered"] = delivered;
  return Conversation.findOneAndUpdate(
    { _id: conversationId, "members.user": userId },
    { $max },
    { projection: { "project.customers": 1 }, new: true }
  ).lean();
};

/** Tells the chat's open screens about a member's new times (customers get the team-only view). */
const broadcast = (io, conversation, userId, { lastRead, lastDelivered }) => {
  if (!io || !conversation) return;
  const conversationId = String(conversation._id);
  const payload = { conversationId, userId: String(userId) };
  if (lastRead) payload.lastRead = lastRead;
  if (lastDelivered || lastRead) payload.lastDelivered = lastDelivered && lastRead && lastDelivered > lastRead ? lastDelivered : lastDelivered || lastRead;
  io.to(teamRoom(conversationId)).emit("chat:receipt", payload);
  // A staff member's receipt, as customers may see it: no name
  if (conversation.project && !isProjectCustomer(conversation, userId)) {
    const team = { conversationId };
    if (payload.lastRead) team.teamLastRead = payload.lastRead;
    if (payload.lastDelivered) team.teamLastDelivered = payload.lastDelivered;
    io.to(customerRoom(conversationId)).emit("chat:receipt", team);
  }
};

/** The person read the chat now. */
const markRead = async (io, conversationId, userId) => {
  const now = new Date();
  const conv = await advance(conversationId, userId, { lastRead: now });
  broadcast(io, conv, userId, { lastRead: now });
  return conv;
};

/**
 * The person's app received messages up to `upTo` (a message time). Times in
 * the future are clamped to now, so nobody can mark messages that don't exist
 * yet as delivered.
 */
const markDelivered = async (io, conversationId, userId, upTo) => {
  const t = new Date(upTo);
  if (Number.isNaN(+t)) return null;
  const at = t > new Date() ? new Date() : t;
  const conv = await advance(conversationId, userId, { lastDelivered: at });
  broadcast(io, conv, userId, { lastDelivered: at });
  return conv;
};

module.exports = { markRead, markDelivered, teamRoom, customerRoom, chatRooms };
