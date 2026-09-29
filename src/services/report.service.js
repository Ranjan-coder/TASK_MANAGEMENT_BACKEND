const mongoose = require("mongoose");
const Report = require("../models/Report");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const Rating = require("../models/Rating");
const ChatSla = require("../models/ChatSla");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { ROLES } = require("../config/roles");
const { nextSequence } = require("../models/Counter");
const { verifyReveal } = require("../utils/franking");
const media = require("./media.service");
const { getEscalationRecipients } = require("./settings.service");

const { REASONS } = Report;
const MAX_PER_DAY = 10;
const MAX_OPEN_SAME_PERSON = 3;
const STAFF_ROLES = [ROLES.USER, ROLES.ADMIN, ROLES.SUPERADMIN];
const OPEN = ["submitted", "under_review"];

const REASON_LABELS = {
  rude: "Rude / disrespectful",
  slow_responses: "Very slow responses",
  unprofessional: "Unprofessional behaviour",
  poor_quality: "Poor quality of work",
  harassment: "Harassment",
  abusive_language: "Abusive language",
  threats: "Threats",
  inappropriate_requests: "Inappropriate requests",
  other: "Other"
};

// What the person who filed the report is told (no HR details)
const PUBLIC_OUTCOME = {
  submitted: "Received — we'll review it within 48 hours.",
  under_review: "Being reviewed by the Bonito team.",
  action_taken: "Reviewed — action has been taken.",
  dismissed: "Reviewed — no further action was needed."
};

const idStr = (v) => (v ? String(v._id || v) : null);
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "Someone";

const notify = async (recipients, payload) => {
  const { sendNotification } = require("./notification.service");
  await Promise.all(
    [...new Set(recipients.filter(Boolean).map(String))].map((recipient) =>
      sendNotification({ recipient, type: "report_update", ...payload }).catch((err) =>
        logger.warn(`Report notification failed: ${err.message}`)
      )
    )
  );
};

// ── Filing ───────────────────────────────────────────────────────────────────

/**
 * Checks the revealed messages against their franking commitments. Only
 * messages from this chat, still visible, and matching their commitment are
 * accepted — so evidence can't be invented or altered.
 */
const verifyEvidence = async (conversationId, evidence) => {
  if (!evidence.length) return [];
  const ids = evidence.map((e) => e.messageId);
  const messages = await Message.find({ _id: { $in: ids }, conversation: conversationId }).select(
    "conversation sender type franking isDeleted isEdited createdAt"
  );
  const byId = new Map(messages.map((m) => [String(m._id), m]));
  return evidence.map((e) => {
    const m = byId.get(e.messageId);
    if (!m || m.type !== "text" || m.isDeleted) throw new ApiError(400, "One of the selected messages isn't in this chat any more.");
    if (!verifyReveal(m, e)) {
      throw new ApiError(400, "One of the selected messages couldn't be verified. Please reload the chat and try again.", [
        { code: "EVIDENCE_NOT_VERIFIED", messageId: e.messageId }
      ]);
    }
    return { message: m._id, sender: m.sender, text: e.text, sentAt: m.createdAt, edited: Boolean(m.isEdited), verified: true };
  });
};

const createReport = async ({ reporter, conversationId, reportedUserId, reason, description, evidence = [], files = [] }) => {
  const conversation = await Conversation.findOne({ _id: conversationId, "members.user": reporter._id }).select("name members project");
  if (!conversation?.project) throw new ApiError(404, "Project chat not found");
  if (String(reportedUserId) === String(reporter._id)) throw new ApiError(400, "You can't report yourself");

  const isMember = conversation.members.some((m) => idStr(m.user) === String(reportedUserId));
  const reported = isMember ? await User.findById(reportedUserId).select("name role") : null;
  if (!reported) throw new ApiError(400, "That person isn't in this project chat");

  const isCustomer = (id) => conversation.project.customers.some((c) => idStr(c) === String(id));
  let direction;
  if (reporter.role === ROLES.CUSTOMER && isCustomer(reporter._id) && STAFF_ROLES.includes(reported.role)) {
    direction = "customer_to_staff";
  } else if (STAFF_ROLES.includes(reporter.role) && reported.role === ROLES.CUSTOMER && isCustomer(reported._id)) {
    direction = "staff_to_customer";
  } else {
    throw new ApiError(400, "Customers can report Bonito staff, and staff can flag customers, in their project chats.");
  }
  if (!REASONS[direction].includes(reason)) throw new ApiError(400, "Choose one of the listed reasons");

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if ((await Report.countDocuments({ reporter: reporter._id, createdAt: { $gte: since } })) >= MAX_PER_DAY) {
    throw new ApiError(429, "You've sent a lot of reports today. Please try again tomorrow.");
  }
  const openAgainst = await Report.countDocuments({ reporter: reporter._id, reportedUser: reported._id, status: { $in: OPEN } });
  if (openAgainst >= MAX_OPEN_SAME_PERSON) {
    throw new ApiError(409, "You already have open reports about this person. We'll update you when they're reviewed.");
  }

  const evidenceMessages = await verifyEvidence(conversation._id, evidence);

  const uploaded = [];
  try {
    for (const file of files) uploaded.push(await media.uploadEvidenceImage(file.buffer));
    const report = await Report.create({
      ticketNo: await nextSequence("report"),
      conversation: conversation._id,
      reporter: reporter._id,
      reportedUser: reported._id,
      direction,
      reason,
      description,
      attachments: uploaded,
      evidenceMessages
    });

    const admins = await getEscalationRecipients();
    const manager = idStr(conversation.project.manager);
    const recipients = [...admins.map((u) => String(u._id)), manager].filter(
      (id) => id && id !== String(reporter._id) && id !== String(reported._id)
    );
    await notify(recipients, {
      title: `New report #${report.ticketNo}`,
      message: `${firstName(reporter.name)} reported ${reported.name} in "${conversation.name}" — ${REASON_LABELS[reason]}.`,
      relatedConversation: null
    });
    return report;
  } catch (err) {
    await Promise.all(uploaded.map((u) => media.destroyEvidence(u.publicId)));
    throw err;
  }
};

// ── Views ────────────────────────────────────────────────────────────────────

const reporterView = (r) => ({
  _id: r._id,
  ticketNo: r.ticketNo,
  status: r.status,
  outcome: PUBLIC_OUTCOME[r.status],
  reason: r.reason,
  reasonLabel: REASON_LABELS[r.reason],
  reportedUser: r.reportedUser ? { _id: r.reportedUser._id, name: r.reportedUser.name } : null,
  projectName: r.conversation?.name || "Project chat",
  evidenceCount: r.evidenceMessages.length + r.attachments.length,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
});

const listMine = async (userId) => {
  const reports = await Report.find({ reporter: userId })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate("reportedUser", "name")
    .populate("conversation", "name");
  return reports.map(reporterView);
};

/** Reports about this user that an admin asked them to respond to. No reporter notes or screenshots. */
const listAboutMe = async (userId) => {
  const reports = await Report.find({ reportedUser: userId, responseRequestedAt: { $ne: null } })
    .sort({ responseRequestedAt: -1 })
    .limit(50)
    .populate("conversation", "name");
  return reports.map((r) => ({
    _id: r._id,
    ticketNo: r.ticketNo,
    status: r.status,
    reasonLabel: REASON_LABELS[r.reason],
    projectName: r.conversation?.name || "Project chat",
    messages: r.evidenceMessages.map((m) => ({ text: m.text, sentAt: m.sentAt, mine: String(m.sender) === String(userId) })),
    responseRequestedAt: r.responseRequestedAt,
    response: r.response?.text ? r.response : null,
    canRespond: OPEN.includes(r.status) && !r.response?.text
  }));
};

const respond = async ({ reportId, user, text }) => {
  const report = await Report.findOneAndUpdate(
    {
      _id: reportId,
      reportedUser: user._id,
      responseRequestedAt: { $ne: null },
      status: { $in: OPEN },
      "response.text": { $exists: false }
    },
    { $set: { response: { text, at: new Date() } } },
    { new: true }
  );
  if (!report) throw new ApiError(409, "This report isn't waiting for your response");
  const admins = await getEscalationRecipients();
  await notify([...admins.map((u) => u._id), report.reviewer].filter((id) => idStr(id) !== String(user._id)), {
    title: `Response received on report #${report.ticketNo}`,
    message: `${user.name} responded to report #${report.ticketNo}.`
  });
  return report;
};

// ── Admin review ─────────────────────────────────────────────────────────────

const PERSON = "name email phone role avatarUrl designation status";

const listForAdmin = async ({ status, direction, page = 1, limit = 30, viewer }) => {
  // Reports that involve the viewing admin are left out of their queue
  const q = viewer ? { reporter: { $ne: viewer._id }, reportedUser: { $ne: viewer._id } } : {};
  if (status) q.status = status;
  if (direction) q.direction = direction;
  const [items, total, counts] = await Promise.all([
    Report.find(q)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-evidenceMessages.text -notes")
      .populate("reporter", PERSON)
      .populate("reportedUser", PERSON)
      .populate("conversation", "name project.status"),
    Report.countDocuments(q),
    Report.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])
  ]);
  return {
    items: items.map((r) => ({ ...r.toObject(), reasonLabel: REASON_LABELS[r.reason], evidenceCount: r.evidenceMessages.length, attachmentCount: r.attachments.length })),
    total,
    page,
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n]))
  };
};

/** Past reports, rating and response-time stats of the reported person (for the reviewer). */
const historyFor = async (user, excludeId) => {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [past, byStatus, rating, sla] = await Promise.all([
    Report.find({ reportedUser: user._id, _id: { $ne: excludeId } }).sort({ createdAt: -1 }).limit(5).select("ticketNo reason status createdAt"),
    Report.aggregate([{ $match: { reportedUser: new mongoose.Types.ObjectId(String(user._id)) } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    user.role === ROLES.CUSTOMER
      ? null
      : Rating.aggregate([{ $match: { designer: new mongoose.Types.ObjectId(String(user._id)) } }, { $group: { _id: null, avg: { $avg: "$stars" }, count: { $sum: 1 } } }]),
    user.role === ROLES.CUSTOMER
      ? null
      : ChatSla.aggregate([
          { $match: { designer: new mongoose.Types.ObjectId(String(user._id)), waitingSince: { $gte: since } } },
          {
            $group: {
              _id: null,
              periods: { $sum: 1 },
              escalations: { $sum: { $cond: [{ $ne: ["$escalatedAt", null] }, 1, 0] } },
              avgReplyMs: { $avg: "$replyWorkingMs" }
            }
          }
        ])
  ]);
  return {
    pastReports: past.map((r) => ({ _id: r._id, ticketNo: r.ticketNo, reasonLabel: REASON_LABELS[r.reason], status: r.status, createdAt: r.createdAt })),
    reportCounts: Object.fromEntries(byStatus.map((c) => [c._id, c.n])),
    rating: rating?.[0] ? { average: Math.round(rating[0].avg * 10) / 10, count: rating[0].count } : null,
    responseTimes90d: sla?.[0]
      ? { periods: sla[0].periods, escalations: sla[0].escalations, avgReplyMinutes: sla[0].avgReplyMs == null ? null : Math.round(sla[0].avgReplyMs / 60000) }
      : null
  };
};

const getForAdmin = async (reportId, viewer) => {
  const involved = viewer ? await Report.exists({ _id: reportId, $or: [{ reporter: viewer._id }, { reportedUser: viewer._id }] }) : null;
  if (involved) throw new ApiError(403, "Another admin must handle a report that involves you.");
  const report = await Report.findById(reportId)
    .populate("reporter", PERSON)
    .populate("reportedUser", PERSON)
    .populate("reviewer", "name email")
    .populate("notes.by", "name")
    .populate("resolution.by", "name")
    .populate("conversation", "name project.status project.leadDesigner project.manager")
    .populate("evidenceMessages.sender", "name role");
  if (!report) throw new ApiError(404, "Report not found");
  const obj = report.toObject();
  return {
    ...obj,
    reasonLabel: REASON_LABELS[report.reason],
    attachments: report.attachments.map((a) => ({ ...a.toObject(), url: media.evidenceUrl(a.publicId) })),
    history: await historyFor(report.reportedUser, report._id)
  };
};

const TRANSITIONS = {
  submitted: ["under_review", "action_taken", "dismissed"],
  under_review: ["action_taken", "dismissed"],
  action_taken: ["under_review"],
  dismissed: ["under_review"]
};

/**
 * One admin update: status change, internal note, asking the reported person
 * to respond, and/or the resolution action. Returns { report, changes }.
 */
const reviewReport = async ({ reportId, admin, status, action, note, requestResponse }) => {
  const report = await Report.findById(reportId).populate("conversation", "name");
  if (!report) throw new ApiError(404, "Report not found");
  if ([String(report.reporter), String(report.reportedUser)].includes(String(admin._id))) {
    throw new ApiError(403, "Someone else must review a report that involves you.");
  }

  const changes = [];
  const reported = await User.findById(report.reportedUser).select("name role");
  const project = report.conversation?.name || "a project chat";

  if (note) {
    report.notes.push({ by: admin._id, text: note, at: new Date() });
    changes.push("note");
  }

  if (requestResponse) {
    if (!OPEN.includes(report.status) && !status) throw new ApiError(409, "Reopen the report before asking for a response");
    if (!report.responseRequestedAt) {
      report.responseRequestedAt = new Date();
      changes.push("response_requested");
      if (report.status === "submitted" && !status) report.status = "under_review";
      await notify([report.reportedUser], {
        title: `Please respond to report #${report.ticketNo}`,
        message: `A report about a conversation in "${project}" is being reviewed. Open Settings → Reports to see it and respond.`
      });
    }
  }

  if (status && status !== report.status) {
    if (!TRANSITIONS[report.status].includes(status)) throw new ApiError(409, `A ${report.status.replace("_", " ")} report can't move to ${status.replace("_", " ")}`);
    if (status === "action_taken" && !action) throw new ApiError(400, "Choose the action that was taken");
    const previous = report.status;
    report.status = status;
    changes.push(`status:${previous}->${status}`);

    if (status === "action_taken" || status === "dismissed") {
      report.resolution = { action: status === "action_taken" ? action : null, note: note || undefined, at: new Date(), by: admin._id };
      await notify([report.reporter], {
        title: `Update on your report #${report.ticketNo}`,
        message: PUBLIC_OUTCOME[status]
      });
      if (status === "action_taken" && action === "warning") {
        await notify([report.reportedUser], {
          title: "Formal warning",
          message: `You've received a formal warning after report #${report.ticketNo} (${REASON_LABELS[report.reason]}) in "${project}". Your manager will follow up.`
        });
      }
    } else {
      report.resolution = { action: null };
    }
  } else if (action && status === undefined) {
    throw new ApiError(400, "Set the status to 'action taken' together with the action");
  }

  if (changes.length === 0) throw new ApiError(400, "Nothing to update");
  report.reviewer = admin._id;
  await report.save();
  return { report, changes, reportedRole: reported?.role };
};

module.exports = {
  createReport,
  listMine,
  listAboutMe,
  respond,
  listForAdmin,
  getForAdmin,
  reviewReport,
  REASON_LABELS
};
