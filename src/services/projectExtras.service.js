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

const stages = require("../config/projectStages");

const STAGE_LABELS = stages.LABELS;
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
  // Company workflows have their own stage keys, so no fixed-list lookup here
  stage: project.stage || stages.FIRST,
  stageHistory: (project.stageHistory || []).map((h) => ({ stage: h.stage, step: h.step || null, from: h.from || null, kind: h.kind || null, at: h.at, note: h.note || "" })),
  expectedHandover: project.expectedHandover || null
});

/**
 * Older "set stage" calls (whole stages). Moves go through the company's workflow
 * (modules/workflows/projectFlow.service.js: rules, handlers, gates, race-proof
 * writes); a note or expected handover date alone is saved here.
 */
const setStage = async ({ conversationId, actor, stage, from, note = "", expectedHandover }) => {
  const flow = require("../modules/workflows/projectFlow.service");
  const conv = await loadProject(conversationId);
  const current = conv.project.stage || stages.FIRST;
  if (from && from !== current) {
    throw new ApiError(409, "Someone just moved this project. Check and try again.", [{ code: "STAGE_CHANGED", stage: current }]);
  }
  let moved = null;
  if (stage !== current) {
    moved = await flow.moveToStage({ conversationId, actor, stage, from: current, note });
  } else {
    if (expectedHandover === undefined && !note) throw new ApiError(400, "Nothing to update");
    const role = await flow.roleFor(actor, conv, null);
    if (!role) throw new ApiError(403, "Only the project's designers, manager or an admin can update the stage");
  }
  if (expectedHandover !== undefined || (!moved && note)) {
    await Conversation.updateOne(
      { _id: conv._id },
      {
        ...(expectedHandover !== undefined && { $set: { "project.expectedHandover": expectedHandover } }),
        ...(!moved && note && { $push: { "project.stageHistory": { $each: [{ stage: current, kind: "note", at: new Date(), by: actor._id, note }], $slice: -500 } } })
      }
    );
  }
  const updated = await Conversation.findById(conv._id).select("name project").lean();
  const view = { conversationId: String(conv._id), status: updated.project.status, ...timelineView(updated.project), move: moved?.move || "same", from: current };
  if (!moved) emit((io) => io.to(`conv:${conv._id}`).emit("chat:project:stage", { conversationId: view.conversationId, expectedHandover: view.expectedHandover }));
  return view;
};

/**
 * How many projects are at each stage (one grouped query), for the admin pipeline.
 * Columns follow the company's current workflow; projects still on an older
 * version at a stage that no longer exists are counted under that stage's key.
 */
const stageCounts = async ({ status } = {}) => {
  const workflows = require("../modules/workflows/workflow.service");
  const [rows, c] = await Promise.all([
    Conversation.aggregate([
      { $match: { project: { $exists: true, $ne: null }, ...(status && { "project.status": status }) } },
      { $group: { _id: { $ifNull: ["$project.stage", stages.FIRST] }, n: { $sum: 1 } } }
    ]),
    workflows.currentCompiled()
  ]);
  const byStage = new Map(rows.map((r) => [r._id, r.n]));
  const out = c.stages.map((s) => ({ stage: s.key, label: s.name, count: byStage.get(s.key) || 0 }));
  for (const [key, n] of byStage) if (!c.stageIndex.has(key)) out.push({ stage: key, label: `${key} (older version)`, count: n, older: true });
  return out;
};

/** The customer's projects with their timelines (for Home). */
const listMyProjects = async (customerId) => {
  const convs = await Conversation.find({ "project.customers": customerId, "members.user": customerId })
    .select("name project lastActivityAt")
    .populate("project.leadDesigner", "name avatarUrl")
    .sort({ lastActivityAt: -1 })
    .lean();
  const views = await require("../modules/workflows/projectFlow.service").customerViews(convs);
  return convs.map((c) => {
    const t = timelineView(c.project);
    return {
      _id: c._id,
      name: c.name,
      status: c.project.status,
      leadDesigner: c.project.leadDesigner ? { name: c.project.leadDesigner.name, avatarUrl: c.project.leadDesigner.avatarUrl } : null,
      lastActivityAt: c.lastActivityAt,
      ...t,
      // Only what was meant for the customer: internal sub-stage moves, ticks and
      // checklists (and their staff notes) stay with the team
      stageHistory: t.stageHistory.filter(customerFacing),
      // The company's own stages, as the customer should see them
      flow: views.get(String(c._id))
    };
  });
};

/** History entries a customer may see: stage changes and what they were told about. */
const CUSTOMER_KINDS = new Set(["activate", "deactivate", "extra", "extra_done", "note"]);
const customerFacing = (h) => {
  if (!h.kind || CUSTOMER_KINDS.has(h.kind)) return true; // older entries: always stage changes
  if (["next", "back", "jump", "migrate"].includes(h.kind)) return !h.from || String(h.from).split("/")[0] !== h.stage; // a different stage
  return false; // tick, untick, checklist: internal
};

// ── R4: design approvals ─────────────────────────────────────────────────────

const APPROVAL_FIELDS = "title status comment decidedAt createdAt message attachment requestedBy decidedBy";
const populateApproval = (q) => q.populate("requestedBy", "name").populate("decidedBy", "name");

const approvalEvent = (approval) =>
  emit((io) => io.to(`conv:${approval.conversation}`).emit("chat:approval", approval));

const requestApproval = async ({ conversationId, actor, messageId, title }) => {
  const conv = await loadProject(conversationId);
  if (!isMember(conv, actor._id) || !STAFF_ROLES.includes(actor.role)) throw new ApiError(403, "Only the design team in this chat can ask for approval");
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
  stageCounts,
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
  deleteQuickReply,
  // Shared with modules/workflows (stage moves post the same notices and events)
  _helpers: { postNotice, notify, emit, loadProject, isTeamLead, isMember, isProjectCustomer, ADMIN_ROLES }
};
