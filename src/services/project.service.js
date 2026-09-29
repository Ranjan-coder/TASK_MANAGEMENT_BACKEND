const mongoose = require("mongoose");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { ROLES } = require("../config/roles");
const { buildInitialKeyring, dropMemberKeys } = require("./groupKeys.service");

/**
 * Project chats: group conversations that Bonito admins set up for a customer
 * with their design team. Only this service changes their membership.
 */

// Staff who can be placed in a project (marketing isn't part of delivery teams)
const PROJECT_STAFF_ROLES = [ROLES.USER, ROLES.ADMIN, ROLES.SUPERADMIN];
const MEMBER_FIELDS = "name avatarUrl status publicKey keyVersion role designation";

const ROLE_LABELS = {
  leadDesigner: "Lead designer",
  backupDesigner: "Backup designer",
  manager: "Project manager"
};

const idStr = (v) => (v ? String(v) : null);
const uniq = (ids) => [...new Set(ids.filter(Boolean).map(String))];

const assertIds = (ids) => {
  for (const id of ids) if (!mongoose.isValidObjectId(id)) throw new ApiError(400, "Invalid user id");
};

/** Loads and checks everyone who will be in the project chat. */
const resolveTeam = async ({ customerIds, leadDesignerId, backupDesignerId, managerId, staffIds }) => {
  const customers = uniq(customerIds || []);
  const staff = uniq([leadDesignerId, backupDesignerId, managerId, ...(staffIds || [])]);
  assertIds([...customers, ...staff]);

  if (!leadDesignerId) throw new ApiError(400, "Choose a lead designer");
  if (customers.length === 0) throw new ApiError(400, "Add at least one customer");
  if (customers.length > 10 || staff.length > 20) throw new ApiError(400, "Too many people in one project chat");
  if (backupDesignerId && idStr(backupDesignerId) === idStr(leadDesignerId)) {
    throw new ApiError(400, "The backup designer must be a different person");
  }
  if (customers.some((c) => staff.includes(c))) throw new ApiError(400, "A person can't be both customer and staff");

  const users = await User.find({ _id: { $in: [...customers, ...staff] } }).select("role status name");
  const byId = new Map(users.map((u) => [String(u._id), u]));

  for (const id of customers) {
    const u = byId.get(id);
    if (!u || u.role !== ROLES.CUSTOMER) throw new ApiError(400, "Customers must be customer accounts");
    if (u.status !== "active") throw new ApiError(400, `${u.name}'s account is not active`);
  }
  for (const id of staff) {
    const u = byId.get(id);
    if (!u || !PROJECT_STAFF_ROLES.includes(u.role)) throw new ApiError(400, "Designers and managers must be Bonito staff accounts");
    if (u.status !== "active") throw new ApiError(400, `${u.name}'s account is not active`);
  }

  // Group admins (can replace the chat key): lead, backup and manager
  const groupAdmins = new Set(uniq([leadDesignerId, backupDesignerId, managerId]));
  const members = [...customers, ...staff].map((id) => ({ user: id, role: groupAdmins.has(id) ? "admin" : "member" }));

  return { customers, staff, members, byId };
};

/** Plain-text notice shown in the chat (server-created, so it can't be spoofed). */
const postSystemMessage = async (conversationId, actorId, content) => {
  const msg = await Message.create({ conversation: conversationId, sender: actorId, type: "system", content });
  await Conversation.updateOne({ _id: conversationId }, { lastMessage: msg._id, lastActivityAt: msg.createdAt });
  return msg.populate("sender", "name avatarUrl");
};

const emit = (fn) => {
  try {
    const io = require("../sockets").getIO();
    if (io) fn(io);
  } catch (err) {
    logger.warn(`Project socket event skipped: ${err.message}`);
  }
};

const notifyUsers = async (userIds, { title, message }) => {
  const { sendNotification } = require("./notification.service");
  await Promise.all(
    userIds.map((recipient) =>
      sendNotification({ recipient, type: "project_update", title, message }).catch((err) =>
        logger.warn(`Project notification failed: ${err.message}`)
      )
    )
  );
};

const populateProject = (query) =>
  query
    .populate("members.user", MEMBER_FIELDS)
    .populate("project.customers", "name email phone avatarUrl")
    .populate("project.leadDesigner", "name avatarUrl")
    .populate("project.backupDesigner", "name avatarUrl")
    .populate("project.manager", "name avatarUrl");

// ── Create ────────────────────────────────────────────────────────────────────

const createProject = async ({ actor, name, customerIds, leadDesignerId, backupDesignerId, managerId, staffIds, encryptedGroupKeys }) => {
  const team = await resolveTeam({ customerIds, leadDesignerId, backupDesignerId, managerId, staffIds });
  const memberIds = team.members.map((m) => String(m.user));

  // The creating admin wraps the first key for the members but is not a member;
  // rekeyRequested makes the team's first staff member replace it on open.
  const groupKeyring = buildInitialKeyring({ keys: encryptedGroupKeys, creatorId: actor._id, memberIdList: memberIds });

  const conversation = await Conversation.create({
    type: "group",
    name: name.trim(),
    createdBy: actor._id,
    members: team.members,
    groupKeyring,
    rekeyRequested: true,
    project: {
      status: "active",
      customers: team.customers,
      leadDesigner: leadDesignerId,
      backupDesigner: backupDesignerId || null,
      manager: managerId || null,
      createdBy: actor._id
    }
  });

  await postSystemMessage(conversation._id, actor._id, `Bonito created this project chat for ${name.trim()}.`);
  const populated = await populateProject(Conversation.findById(conversation._id));

  emit((io) => memberIds.forEach((uid) => io.to(`user:${uid}`).emit("conversation:created", populated)));
  notifyUsers(team.customers, {
    title: "Your project chat is ready",
    message: `Chat with your Bonito design team about "${name.trim()}" in Chat.`
  });
  notifyUsers(team.staff, {
    title: "You've been added to a project",
    message: `${name.trim()}: open Chat to meet the customer.`
  });

  return populated;
};

// ── Update ────────────────────────────────────────────────────────────────────

const describe = (u) => u?.name || "A team member";

/**
 * Replaces the project's team with the given one (desired state). Removed
 * people lose access at once and a new key is requested; added people receive
 * the existing keys from any member's app (group-key sharing).
 */
const updateProject = async (id, { actor, name, status, customerIds, leadDesignerId, backupDesignerId, managerId, staffIds }) => {
  const conversation = await Conversation.findById(id);
  if (!conversation?.project) throw new ApiError(404, "Project not found");

  const team = await resolveTeam({ customerIds, leadDesignerId, backupDesignerId, managerId, staffIds });
  const before = new Set(conversation.members.map((m) => String(m.user)));
  const after = new Set(team.members.map((m) => String(m.user)));
  const removed = [...before].filter((u) => !after.has(u));
  const added = [...after].filter((u) => !before.has(u));

  const notices = [];
  for (const [field, label] of Object.entries(ROLE_LABELS)) {
    const next = { leadDesigner: leadDesignerId, backupDesigner: backupDesignerId, manager: managerId }[field] || null;
    if (idStr(conversation.project[field]) !== idStr(next) && next) {
      notices.push(`${describe(team.byId.get(String(next)))} is now the ${label.toLowerCase()}.`);
    }
  }
  if (removed.length) {
    const gone = await User.find({ _id: { $in: removed } }).select("name");
    gone.forEach((u) => notices.push(`${u.name} left the project chat.`));
    removed.forEach((uid) => dropMemberKeys(conversation, uid));
    conversation.rekeyRequested = true; // they must not read anything sent from now on
  }
  const statusChanged = status && status !== conversation.project.status;
  if (statusChanged) {
    notices.push(
      { active: "This project is active again.", on_hold: "This project is on hold.", completed: "This project is marked as completed." }[status]
    );
  }

  const oldMembers = new Map(conversation.members.map((m) => [String(m.user), m]));
  conversation.members = team.members.map((m) => ({
    ...m,
    joinedAt: oldMembers.get(String(m.user))?.joinedAt || new Date(),
    lastRead: oldMembers.get(String(m.user))?.lastRead || null
  }));
  if (name) conversation.name = name.trim();
  conversation.project.customers = team.customers;
  conversation.project.leadDesigner = leadDesignerId;
  conversation.project.backupDesigner = backupDesignerId || null;
  conversation.project.manager = managerId || null;
  if (status) conversation.project.status = status;
  conversation.markModified("project");
  await conversation.save();

  for (const text of notices) await postSystemMessage(conversation._id, actor._id, text);
  const populated = await populateProject(Conversation.findById(conversation._id));

  emit((io) => {
    // Removed people stop receiving this chat's live events immediately
    removed.forEach((uid) => {
      io.in(`user:${uid}`).socketsLeave(`conv:${id}`);
      io.to(`user:${uid}`).emit("chat:member:removed", { conversationId: id, userId: uid });
    });
    added.forEach((uid) => io.to(`user:${uid}`).emit("conversation:created", populated));
    io.to(`conv:${id}`).emit("chat:project:updated", populated);
  });
  const addedCustomers = added.filter((u) => team.customers.includes(u));
  if (addedCustomers.length) {
    notifyUsers(addedCustomers, { title: "Your project chat is ready", message: `Chat with your Bonito design team about "${conversation.name}".` });
  }
  const addedStaff = added.filter((u) => !team.customers.includes(u));
  if (addedStaff.length) {
    notifyUsers(addedStaff, { title: "You've been added to a project", message: `${conversation.name}: open Chat to catch up.` });
  }
  if (statusChanged && status === "completed") {
    notifyUsers(team.customers, {
      title: "How did we do?",
      message: `"${conversation.name}" is complete. Open the project chat to rate your designer.`
    });
  }

  return { project: populated, removed, added };
};

// ── Read ──────────────────────────────────────────────────────────────────────

// The list screen never needs the chat key rings (they grow with every rekey and member)
const listProjects = async ({ status } = {}) => {
  const filter = { project: { $exists: true } };
  if (status) filter["project.status"] = status;
  return populateProject(Conversation.find(filter).select("-groupKeyring -groupKeys").sort({ lastActivityAt: -1 }).limit(500));
};

const getProject = async (id) => {
  const project = await populateProject(Conversation.findOne({ _id: id, project: { $exists: true } }));
  if (!project) throw new ApiError(404, "Project not found");
  return project;
};

module.exports = { createProject, updateProject, listProjects, getProject, ROLE_LABELS, PROJECT_STAFF_ROLES };
