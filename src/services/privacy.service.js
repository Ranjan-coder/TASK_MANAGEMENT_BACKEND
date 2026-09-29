const crypto = require("crypto");
const User = require("../models/User");
const Conversation = require("../models/Conversation");
const Lead = require("../models/Lead");
const Rating = require("../models/Rating");
const Report = require("../models/Report");
const DesignApproval = require("../models/DesignApproval");
const Notification = require("../models/Notification");
const DeletionRequest = require("../models/DeletionRequest");
const PushSubscription = require("../models/PushSubscription");
const OfflineAlert = require("../models/OfflineAlert");
const OtpChallenge = require("../models/OtpChallenge");
const ChatSla = require("../models/ChatSla");
const Setting = require("../models/Setting");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { ROLES } = require("../config/roles");
const media = require("./media.service");
const { dropMemberKeys } = require("./groupKeys.service");

/**
 * DPDP Act 2023 (R8): data export, account deletion requests and retention.
 * Chat messages are end-to-end encrypted, so the server can only export them
 * as ciphertext; the app decrypts and adds them on the person's device.
 */

const DAY = 24 * 3600 * 1000;
const RETENTION = {
  otpDays: 90,
  slaDays: 90,
  readNotificationDays: 180,
  closedReportEvidenceDays: 365
};
const idStr = (v) => (v ? String(v._id || v) : null);

// ── Export ───────────────────────────────────────────────────────────────────

const exportMyData = async (userId) => {
  const user = await User.findById(userId)
    .select("name email phone phoneVerified role status designation department avatarUrl createdAt lastLogin consent notificationPrefs availability currentSessions referralCode")
    .lean();
  if (!user) throw new ApiError(404, "Account not found");

  const ProjectFinance = require("../models/ProjectFinance");
  const Referral = require("../models/Referral");
  const [projects, leads, ratings, reportsMade, approvals, notifications, deletion] = await Promise.all([
    Conversation.find({ "members.user": userId, project: { $exists: true } })
      .select("name project.status project.stage project.stageHistory.stage project.stageHistory.at project.stageHistory.note project.expectedHandover createdAt")
      .lean(),
    Lead.find({ customer: userId }).select("campaign message status createdAt").populate("campaign", "title").lean(),
    Rating.find({ customer: userId }).select("conversation stars tags comment createdAt updatedAt").lean(),
    Report.find({ reporter: userId }).select("ticketNo reason description status createdAt evidenceMessages.text evidenceMessages.sentAt").lean(),
    DesignApproval.find({ decidedBy: userId }).select("title status comment decidedAt conversation").lean(),
    Notification.find({ recipient: userId }).select("type title message createdAt isRead").sort({ createdAt: -1 }).limit(500).lean(),
    DeletionRequest.find({ user: userId }).select("status reason createdAt handledAt").lean()
  ]);
  // Reports about this person: only the fact and outcome, not who reported them (protects the reporter)
  const reportsAbout = await Report.find({ reportedUser: userId, responseRequestedAt: { $ne: null } }).select("ticketNo reason status createdAt response").lean();

  const finances = await ProjectFinance.find({ conversation: { $in: projects.map((p) => p._id) } }).lean();
  const referralsMade = await Referral.find({ referrer: userId }).populate("referred", "name").lean();
  const referredBy = await Referral.findOne({ referred: userId }).lean();
  return {
    exportedAt: new Date(),
    format: "bonito-data-export-v1",
    note: "Chat messages are end-to-end encrypted. The Bonito app adds your readable chat history to this file on your device; Bonito's servers cannot read it.",
    account: {
      ...user,
      currentSessions: (user.currentSessions || []).map((s) => ({ deviceName: s.deviceName, createdAt: s.createdAt, lastActive: s.lastActive, ipAddress: s.ipAddress }))
    },
    projects: projects.map((p) => ({ _id: p._id, name: p.name, status: p.project?.status, stage: p.project?.stage, stageHistory: p.project?.stageHistory, expectedHandover: p.project?.expectedHandover })),
    consultationRequests: leads.map((l) => ({ campaign: l.campaign?.title || null, message: l.message, status: l.status, createdAt: l.createdAt })),
    ratingsGiven: ratings,
    reportsMade,
    reportsAboutYou: reportsAbout,
    designDecisions: approvals,
    payments: finances.map((f) => ({
      project: projects.find((p) => String(p._id) === String(f.conversation))?.name,
      contractValuePaise: f.contractValuePaise,
      milestones: f.milestones.map((m) => ({
        title: m.title,
        amountPaise: m.amountPaise,
        dueDate: m.dueDate,
        status: m.status,
        yourPaymentReport: m.claim ? { method: m.claim.method, reference: m.claim.reference, amountPaise: m.claim.amountPaise, paidOn: m.claim.paidOn } : null,
        paid: m.paid?.receiptNo ? { amountPaise: m.paid.amountPaise, method: m.paid.method, reference: m.paid.reference, paidOn: m.paid.paidOn, receiptNo: m.paid.receiptNo } : null
      }))
    })),
    referrals: {
      yourCode: user.referralCode || null,
      friendsYouReferred: referralsMade.map((r) => ({ friend: String(r.referred?.name || "").split(" ")[0], status: r.status, createdAt: r.createdAt })),
      youWereReferred: referredBy ? { status: referredBy.status, createdAt: referredBy.createdAt } : null
    },
    notifications,
    deletionRequests: deletion
  };
};

// ── Deletion requests ────────────────────────────────────────────────────────

const requestDeletion = async (user, reason = "") => {
  if (user.role !== ROLES.CUSTOMER) throw new ApiError(403, "Staff accounts are closed through Bonito HR");
  try {
    return await DeletionRequest.create({ user: user._id, reason });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, "You already have a pending deletion request");
    throw err;
  }
};

const cancelDeletion = async (userId) => {
  const r = await DeletionRequest.findOneAndUpdate({ user: userId, status: "pending" }, { $set: { status: "cancelled", handledAt: new Date() } }, { new: true });
  if (!r) throw new ApiError(404, "No pending request");
  return r;
};

const myDeletionStatus = (userId) => DeletionRequest.findOne({ user: userId }).sort({ createdAt: -1 }).select("status reason note createdAt handledAt").lean();

const listDeletionRequests = async ({ status }) => {
  const rows = await DeletionRequest.find(status ? { status } : {})
    .sort({ createdAt: -1 })
    .limit(200)
    .populate("user", "name email phone status createdAt deletedAt")
    .populate("handledBy", "name")
    .lean();
  // Flag open matters that the reviewer should know about before deleting
  return Promise.all(
    rows.map(async (r) => {
      if (r.status !== "pending" || !r.user) return r;
      const [openReports, activeProjects] = await Promise.all([
        Report.countDocuments({ $or: [{ reporter: r.user._id }, { reportedUser: r.user._id }], status: { $in: ["submitted", "under_review"] } }),
        Conversation.countDocuments({ "project.customers": r.user._id, "project.status": { $in: ["active", "on_hold"] } })
      ]);
      return { ...r, openReports, activeProjects };
    })
  );
};

/**
 * Deletes a customer's personal data. Messages they sent stay in the project
 * chats as encrypted records under "Deleted customer" (other members were
 * part of those conversations, and they may be needed for disputes); the
 * rest is removed or anonymised.
 */
const anonymiseCustomer = async (userId) => {
  const user = await User.findById(userId);
  if (!user || user.role !== ROLES.CUSTOMER) throw new ApiError(400, "Only customer accounts can be deleted here");

  // Leave every project chat; their key copies are dropped and the chat gets a new key
  const convs = await Conversation.find({ "members.user": userId });
  for (const conv of convs) {
    conv.members = conv.members.filter((m) => idStr(m.user) !== String(userId));
    dropMemberKeys(conv, userId);
    if (conv.project) {
      conv.project.customers = conv.project.customers.filter((c) => idStr(c) !== String(userId));
      conv.rekeyRequested = true;
      conv.markModified("project");
    }
    if (conv.members.length < 2) conv.isArchived = true;
    await conv.save({ validateBeforeSave: false });
    try {
      require("../sockets").getIO()?.in(`user:${userId}`).socketsLeave(`conv:${conv._id}`);
    } catch {
      /* socket layer optional */
    }
  }

  const [leads, ratings, notifications, subs, alerts] = await Promise.all([
    Lead.deleteMany({ customer: userId }),
    Rating.updateMany({ customer: userId }, { $set: { comment: "" } }), // stars stay (anonymous) for the designer's average
    Notification.deleteMany({ recipient: userId }),
    PushSubscription.deleteMany({ user: userId }),
    OfflineAlert.deleteMany({ user: userId })
  ]);
  await OtpChallenge.deleteMany({ $or: [{ user: userId }, ...(user.phone ? [{ phone: user.phone }] : [])] }).catch(() => {});

  // Traces of the name elsewhere: friend leads ("Referred by …"), staff notifications, audit details
  const oldName = user.name;
  const Lead2 = require("../models/Lead");
  const AuditLog = require("../models/AuditLog");
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await Lead2.updateMany({ message: `Referred by ${oldName}` }, { $set: { message: "Referred by a customer who has since deleted their account" } });
  if (oldName && oldName.trim().length >= 4) {
    await Notification.updateMany({ $or: [{ message: { $regex: escapeRe(oldName) } }, { title: { $regex: escapeRe(oldName) } }] }, [
      {
        $set: {
          message: { $replaceAll: { input: "$message", find: oldName, replacement: "A deleted customer" } },
          title: { $replaceAll: { input: "$title", find: oldName, replacement: "A deleted customer" } }
        }
      }
    ]);
  }
  await AuditLog.updateMany({ targetId: userId, "metadata.email": { $exists: true } }, { $set: { "metadata.email": "[deleted]", "metadata.phone": "[deleted]" } });

  const id = String(user._id);
  user.referralCode = undefined;
  user.name = "Deleted customer";
  user.email = `deleted-${id}@deleted.invalid`;
  user.phone = undefined;
  user.pendingPhone = undefined;
  user.phoneVerified = false;
  user.avatarUrl = "";
  user.status = "inactive";
  user.deletedAt = new Date();
  user.notificationPrefs = { whatsapp: false, sms: false, updatedAt: new Date() };
  user.currentSessions = [];
  user.refreshTokens = [];
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.keyBundle = undefined;
  user.recoveryBundle = undefined;
  user.setDerivedCredential(crypto.randomBytes(32).toString("base64"), crypto.randomBytes(16).toString("base64")); // nobody can sign in
  await user.save({ validateBeforeSave: false });
  await require("../sockets").disconnectSessions(user._id);

  return {
    // Kept on purpose: payment records and receipts (tax law), report and design-approval records (disputes),
    // encrypted messages they sent, and the audit log of who did what (security)
    kept: ["payments_and_receipts", "reports_and_approvals", "encrypted_messages", "audit_log"],
    projectsLeft: convs.length,
    leadsDeleted: leads.deletedCount,
    ratingsAnonymised: ratings.modifiedCount,
    notificationsDeleted: notifications.deletedCount,
    devicesRemoved: subs.deletedCount,
    alertsRemoved: alerts.deletedCount
  };
};

const handleDeletionRequest = async ({ requestId, admin, decision, note = "" }) => {
  const request = await DeletionRequest.findById(requestId);
  if (!request) throw new ApiError(404, "Request not found");
  if (request.status !== "pending") throw new ApiError(409, "This request has already been handled");
  if (String(request.user) === String(admin._id)) throw new ApiError(403, "Someone else must handle a request about you");
  if (decision === "reject" && note.trim().length < 10) throw new ApiError(400, "Explain to the customer why it can't be deleted yet");

  // Claim first so two admins can't process it at once
  const claimed = await DeletionRequest.findOneAndUpdate({ _id: requestId, status: "pending" }, { $set: { status: decision === "approve" ? "completed" : "rejected", handledBy: admin._id, handledAt: new Date(), note } }, { new: true });
  if (!claimed) throw new ApiError(409, "This request has already been handled");

  if (decision === "approve") {
    try {
      claimed.summary = await anonymiseCustomer(request.user);
      await claimed.save();
    } catch (err) {
      await DeletionRequest.updateOne({ _id: requestId }, { $set: { status: "pending", handledBy: null, handledAt: null } });
      throw err;
    }
  } else {
    const { sendNotification } = require("./notification.service");
    await sendNotification({ recipient: request.user, type: "security_alert", title: "About your deletion request", message: note.slice(0, 300) }).catch(() => {});
  }
  return claimed;
};

// ── Retention (runs from the minute job, at most every 6 hours) ──────────────

let lastRun = 0;
const RUN_EVERY_MS = 6 * 3600 * 1000;

const runRetention = async (now = new Date()) => {
  const out = {};
  out.otp = (await OtpChallenge.deleteMany({ createdAt: { $lt: new Date(+now - RETENTION.otpDays * DAY) } })).deletedCount;
  out.sla = (await ChatSla.deleteMany({ open: false, waitingSince: { $lt: new Date(+now - RETENTION.slaDays * DAY) } })).deletedCount;
  out.notifications = (await Notification.deleteMany({ isRead: true, createdAt: { $lt: new Date(+now - RETENTION.readNotificationDays * DAY) } })).deletedCount;

  // Report evidence: kept 1 year after the report was closed, then removed (the outcome record stays)
  const oldReports = await Report.find({
    status: { $in: ["action_taken", "dismissed"] },
    "resolution.at": { $lt: new Date(+now - RETENTION.closedReportEvidenceDays * DAY) },
    evidencePurgedAt: { $exists: false }
  }).limit(200);
  for (const r of oldReports) {
    for (const a of r.attachments) await media.destroyEvidence(a.publicId);
    await Report.updateOne(
      { _id: r._id },
      { $set: { attachments: [], evidenceMessages: [], description: "[removed after the retention period]", evidencePurgedAt: now } }
    );
  }
  out.reportEvidence = oldReports.length;
  return out;
};

const runRetentionIfDue = async () => {
  if (Date.now() - lastRun < RUN_EVERY_MS) return null;
  lastRun = Date.now();
  // One server at a time: a stamp in the settings document acts as a lock
  const claimed = await Setting.findOneAndUpdate(
    { key: "global", $or: [{ retentionRunAt: null }, { retentionRunAt: { $lt: new Date(Date.now() - RUN_EVERY_MS) } }] },
    { $set: { retentionRunAt: new Date() } },
    { new: true }
  );
  if (!claimed) return null;
  try {
    const out = await runRetention();
    if (Object.values(out).some(Boolean)) logger.info(`[Retention] removed ${JSON.stringify(out)}`);
    return out;
  } catch (err) {
    logger.error(`[Retention] failed: ${err.message}`);
    return null;
  }
};

module.exports = {
  RETENTION,
  exportMyData,
  requestDeletion,
  cancelDeletion,
  myDeletionStatus,
  listDeletionRequests,
  handleDeletionRequest,
  anonymiseCustomer,
  runRetention,
  runRetentionIfDue
};
