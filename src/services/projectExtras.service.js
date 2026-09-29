const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const DesignApproval = require("../models/DesignApproval");
const QuickReply = require("../models/QuickReply");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { ROLES } = require("../config/roles");

const { PROJECT_STAGES } = Conversation;

/**
 * Phase 8 features for project chats: the status timeline (R1), design
 * approvals (R4) and quick-reply templates (R5).
 */

const STAGE_LABELS = {
  consultation: "Consultation",
  site_measurement: "Site measurement",
  design: "Design",
  quotation: "Quotation",
  production: "Production",
  installation: "Installation",
  handover: "Handover"
};
const ADMIN_ROLES = [ROLES.ADMIN, ROLES.SUPERADMIN];
const STAFF_ROLES = [ROLES.USER, ROLES.ADMIN, ROLES.SUPERADMIN];
const idStr = (v) => (v ? String(v._id || v) : null);
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "Someone";

const emit = (fn) => {
  try {
    const io = require("../sockets").getIO();
    if (io) fn(io);
  } catch (err) {
    logger.warn(`Project socket event skipped: ${err.message}`);
  }
};

const notify = async (recipients, payload) => {
  const { sendNotification } = require("./notification.service");
  await Promise.all(
    [...new Set(recipients.filter(Boolean).map(String))].map((recipient) =>
      sendNotification({ recipient, type: "project_update", ...payload }).catch((err) => logger.warn(`Project notification failed: ${err.message}`))
    )
  );
};

const postNotice = async (conversationId, senderId, content) => {
  const msg = await Message.create({ conversation: conversationId, sender: senderId, type: "system", content });
  await Conversation.updateOne({ _id: conversationId }, { lastMessage: msg._id, lastActivityAt: msg.createdAt });
  await msg.populate("sender", "name avatarUrl");
  emit((io) => io.to(`conv:${conversationId}`).emit("chat:message", msg));
  return msg;
};

const isMember = (conv, userId) => conv.members.some((m) => idStr(m.user) === String(userId));
const isProjectCustomer = (conv, userId) => conv.project.customers.some((c) => idStr(c) === String(userId)) && isMember(conv, userId);
const isTeamLead = (conv, userId) => [conv.project.leadDesigner, conv.project.backupDesigner, conv.project.manager].some((u) => idStr(u) === String(userId));

const loadProject = async (conversationId) => {
  const conv = await Conversation.findById(conversationId).select("name members project");
  if (!conv?.project) throw new ApiError(404, "Project not found");
  return conv;
};

// ── R1: status timeline ──────────────────────────────────────────────────────

const timelineView = (project) => ({
  stage: project.stage || "consultation",
  stageHistory: (project.stageHistory || []).map((h) => ({ stage: h.stage, at: h.at, note: h.note || "" })),
  expectedHandover: project.expectedHandover || null
});

/** Lead/backup designer, project manager or an admin moves the project to a stage. */
const setStage = async ({ conversationId, actor, stage, note = "", expectedHandover }) => {
  const conv = await loadProject(conversationId);
  if (!ADMIN_ROLES.includes(actor.role) && !(isTeamLead(conv, actor._id) && isMember(conv, actor._id))) {
    throw new ApiError(403, "Only the project's designers, manager or an admin can update the stage");
  }
  if (!PROJECT_STAGES.includes(stage)) throw new ApiError(400, "Unknown stage");
  const changed = stage !== (conv.project.stage || "consultation");
  if (!changed && expectedHandover === undefined && !note) throw new ApiError(400, "Nothing to update");

  if (changed) {
    conv.project.stage = stage;
    conv.project.stageHistory.push({ stage, at: new Date(), by: actor._id, note });
  } else if (note) {
    conv.project.stageHistory.push({ stage, at: new Date(), by: actor._id, note });
  }
  if (expectedHandover !== undefined) conv.project.expectedHandover = expectedHandover;
  conv.markModified("project");
  await conv.save();

  if (changed) {
    const label = STAGE_LABELS[stage];
    await postNotice(conv._id, actor._id, `📍 Project stage: ${label}${note ? ` — ${note}` : ""}`);
    await notify(conv.project.customers, { title: `Your project is now at: ${label}`, message: `"${conv.name}"${note ? ` — ${note}` : ""}`, relatedConversation: conv._id });
  }
  const view = { conversationId: String(conv._id), ...timelineView(conv.project) };
  emit((io) => io.to(`conv:${conv._id}`).emit("chat:project:stage", view));
  return view;
};

/** The customer's projects with their timelines (for Home). */
const listMyProjects = async (customerId) => {
  const convs = await Conversation.find({ "project.customers": customerId, "members.user": customerId })
    .select("name project lastActivityAt")
    .populate("project.leadDesigner", "name avatarUrl")
    .sort({ lastActivityAt: -1 })
    .lean();
  return convs.map((c) => ({
    _id: c._id,
    name: c.name,
    status: c.project.status,
    leadDesigner: c.project.leadDesigner ? { name: c.project.leadDesigner.name, avatarUrl: c.project.leadDesigner.avatarUrl } : null,
    lastActivityAt: c.lastActivityAt,
    ...timelineView(c.project)
  }));
};

// ── R4: design approvals ─────────────────────────────────────────────────────

const APPROVAL_FIELDS = "title status comment decidedAt createdAt message attachment requestedBy decidedBy";
const populateApproval = (q) => q.populate("requestedBy", "name").populate("decidedBy", "name");

const approvalEvent = (approval) =>
  emit((io) => io.to(`conv:${approval.conversation}`).emit("chat:approval", approval));

const requestApproval = async ({ conversationId, actor, messageId, title }) => {
  const conv = await loadProject(conversationId);
  if (!isMember(conv, actor._id) || !STAFF_ROLES.includes(actor.role)) throw new ApiError(403, "Only the Bonito team in this chat can ask for approval");
  const message = await Message.findOne({ _id: messageId, conversation: conv._id });
  if (!message || message.isDeleted) throw new ApiError(404, "Message not found");
  if (!["image", "file"].includes(message.type) || !message.attachments?.length) throw new ApiError(400, "Ask for approval on a design you've posted (an image or file)");

  const att = message.attachments[0];
  let approval;
  try {
    approval = await DesignApproval.create({
      conversation: conv._id,
      message: message._id,
      title,
      requestedBy: actor._id,
      attachment: { publicId: att.publicId || att.url, originalName: att.originalName, fileSize: att.fileSize, messageCreatedAt: message.createdAt }
    });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, "This design is already waiting for approval");
    throw err;
  }
  await postNotice(conv._id, actor._id, `📐 ${firstName(actor.name)} asked for approval: "${title}"`);
  await notify(conv.project.customers, { title: "A design needs your approval", message: `"${title}" in ${conv.name}`, relatedConversation: conv._id });
  const populated = await populateApproval(DesignApproval.findById(approval._id));
  approvalEvent(populated);
  return populated;
};

const decideApproval = async ({ approvalId, actor, decision, comment = "" }) => {
  const existing = await DesignApproval.findById(approvalId);
  if (!existing) throw new ApiError(404, "Approval not found");
  const conv = await loadProject(existing.conversation);
  if (!isProjectCustomer(conv, actor._id)) throw new ApiError(403, "Only the customer can approve designs");
  if (decision === "changes_requested" && comment.trim().length < 3) throw new ApiError(400, "Tell the designer what to change");

  const approval = await DesignApproval.findOneAndUpdate(
    { _id: approvalId, status: "pending" },
    { $set: { status: decision, decidedBy: actor._id, decidedAt: new Date(), comment: comment.trim() } },
    { new: true }
  );
  if (!approval) throw new ApiError(409, "This design has already been answered");

  const text =
    decision === "approved"
      ? `✅ ${firstName(actor.name)} approved "${approval.title}"`
      : `✏️ ${firstName(actor.name)} asked for changes to "${approval.title}": ${approval.comment}`;
  await postNotice(conv._id, actor._id, text);
  await notify([approval.requestedBy], {
    title: decision === "approved" ? "Design approved" : "Changes requested",
    message: `${actor.name} — "${approval.title}"${decision === "approved" ? "" : `: ${approval.comment.slice(0, 140)}`}`,
    relatedConversation: conv._id
  });
  const { recordAuditLog } = require("./audit.service");
  await recordAuditLog({ actorId: actor._id, action: `design_${decision}`, targetType: "System", targetId: approval._id, metadata: { conversation: conv._id, message: approval.message } });
  const populated = await populateApproval(DesignApproval.findById(approval._id));
  approvalEvent(populated);
  return populated;
};

const withdrawApproval = async ({ approvalId, actor }) => {
  const existing = await DesignApproval.findById(approvalId);
  if (!existing) throw new ApiError(404, "Approval not found");
  const conv = await loadProject(existing.conversation);
  if (!(String(existing.requestedBy) === String(actor._id) || isTeamLead(conv, actor._id)) || !isMember(conv, actor._id)) {
    throw new ApiError(403, "Only the person who asked, or the project's designers, can withdraw it");
  }
  const approval = await DesignApproval.findOneAndUpdate({ _id: approvalId, status: "pending" }, { $set: { status: "withdrawn" } }, { new: true });
  if (!approval) throw new ApiError(409, "This design has already been answered");
  await postNotice(conv._id, actor._id, `${firstName(actor.name)} withdrew the approval request for "${approval.title}"`);
  const populated = await populateApproval(DesignApproval.findById(approval._id));
  approvalEvent(populated);
  return populated;
};

const listApprovals = async (conversationId) =>
  populateApproval(DesignApproval.find({ conversation: conversationId }).select(APPROVAL_FIELDS).sort({ createdAt: -1 }).limit(200));

/** Messages with an approval can't be deleted for everyone (the sign-off must stay checkable). */
const hasApproval = (messageId) => DesignApproval.exists({ message: messageId, status: { $ne: "withdrawn" } });

// ── R5: quick replies ────────────────────────────────────────────────────────

const DEFAULT_REPLIES = [
  { title: "Greeting", text: "Hi {customer}, thanks for your message! I'm looking into this and will get back to you shortly." },
  { title: "Working on it", text: "Hi {customer}, I'm working on your design and will share an update by end of day." },
  { title: "Site visit", text: "Hi {customer}, can we schedule the site measurement visit? Please share a convenient date and time." },
  { title: "Quote shared", text: "Hi {customer}, I've shared the quotation above. Happy to walk you through it on a call." },
  { title: "Design ready", text: "Hi {customer}, the design is ready for your review. Please take a look and tap Approve or Request changes." }
];
const MAX_OWN = 50;

const ensureDefaults = async () => {
  if (await QuickReply.exists({ owner: null })) return;
  await QuickReply.insertMany(DEFAULT_REPLIES.map((r) => ({ ...r, owner: null })));
};

const listQuickReplies = async (user) => {
  await ensureDefaults();
  const rows = await QuickReply.find({ $or: [{ owner: null }, { owner: user._id }] }).sort({ owner: -1, title: 1 }).lean();
  return rows.map((r) => ({ _id: r._id, title: r.title, text: r.text, shared: !r.owner, canEdit: r.owner ? true : ADMIN_ROLES.includes(user.role) }));
};

const createQuickReply = async (user, { title, text, shared }) => {
  if (shared && !ADMIN_ROLES.includes(user.role)) throw new ApiError(403, "Only admins can add shared replies");
  if (!shared && (await QuickReply.countDocuments({ owner: user._id })) >= MAX_OWN) throw new ApiError(400, `You can keep up to ${MAX_OWN} replies`);
  return QuickReply.create({ title, text, owner: shared ? null : user._id, createdBy: user._id });
};

const editableReply = async (user, id) => {
  const reply = await QuickReply.findById(id);
  if (!reply) throw new ApiError(404, "Reply not found");
  const own = reply.owner && String(reply.owner) === String(user._id);
  if (!own && !(reply.owner === null && ADMIN_ROLES.includes(user.role))) throw new ApiError(404, "Reply not found");
  return reply;
};

const updateQuickReply = async (user, id, patch) => {
  const reply = await editableReply(user, id);
  Object.assign(reply, patch);
  await reply.save();
  return reply;
};

const deleteQuickReply = async (user, id) => {
  const reply = await editableReply(user, id);
  await reply.deleteOne();
};

module.exports = {
  STAGE_LABELS,
  setStage,
  listMyProjects,
  timelineView,
  requestApproval,
  decideApproval,
  withdrawApproval,
  listApprovals,
  hasApproval,
  listQuickReplies,
  createQuickReply,
  updateQuickReply,
  deleteQuickReply
};
