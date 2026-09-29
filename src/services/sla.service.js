const ChatSla = require("../models/ChatSla");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { mapLimit } = require("../utils/mapLimit");
const redisClient = require("../config/redis");
const { ROLES } = require("../config/roles");
const hoursUtil = require("../utils/businessHours");
const { getSlaSettings, getEscalationRecipients } = require("./settings.service");

/**
 * Reply timers for project chats (plan §5).
 *
 * A waiting period opens on the first unanswered customer message and closes
 * when any staff member in the chat replies. Deadlines count working time
 * only. The every-minute monitor (jobs/slaMonitor.job.js) moves each open
 * period through: waiting → auto_replied (15) → reminded (60) → escalated (120).
 * Every step is claimed with an atomic update on `stage`, so an action never
 * runs twice, even with several servers.
 */

const SNOOZE_MS = 10 * 60 * 1000;
const AFTER_HOURS_NOTICE_GAP_MS = 12 * 60 * 60 * 1000;
const TIMED_STATUSES = ["active", "on_hold"]; // completed projects have no timers

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "Your designer";
const idStr = (v) => (v ? String(v._id || v) : null);

const emit = (fn) => {
  try {
    const io = require("../sockets").getIO();
    if (io) fn(io);
  } catch (err) {
    logger.warn(`SLA socket event skipped: ${err.message}`);
  }
};

const notify = async (recipients, payload) => {
  const { sendNotification } = require("./notification.service");
  await Promise.all(
    recipients.map((recipient) =>
      sendNotification({ recipient, ...payload }).catch((err) => logger.warn(`SLA notification failed: ${err.message}`))
    )
  );
};

/** Server-written notice in the chat (plain text, can't be spoofed by members). */
const postNotice = async (conversationId, senderId, content) => {
  const msg = await Message.create({ conversation: conversationId, sender: senderId, type: "system", content });
  await Conversation.updateOne({ _id: conversationId }, { lastMessage: msg._id, lastActivityAt: msg.createdAt });
  await msg.populate("sender", "name avatarUrl");
  emit((io) => io.to(`conv:${conversationId}`).emit("chat:message", msg));
  return msg;
};

const isOnLeave = (user, now = new Date()) =>
  user?.availability?.status === "on_leave" && (!user.availability.until || new Date(user.availability.until) > now);

const isOnline = async (userId) => {
  if (!redisClient || redisClient.status !== "ready") return null; // unknown without Redis
  try {
    return Boolean(await redisClient.get(`presence:${userId}`));
  } catch {
    return null;
  }
};

const loadTeam = async (conversation) => {
  const ids = [conversation.project.leadDesigner, conversation.project.backupDesigner].filter(Boolean);
  const users = await User.find({ _id: { $in: ids } }).select("name status availability");
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return {
    lead: byId.get(idStr(conversation.project.leadDesigner)) || null,
    backup: byId.get(idStr(conversation.project.backupDesigner)) || null
  };
};

const isCustomerMember = (conversation, userId) =>
  (conversation.project?.customers || []).some((c) => idStr(c) === String(userId)) &&
  conversation.members.some((m) => idStr(m.user) === String(userId));

// ── Message hook ─────────────────────────────────────────────────────────────

/**
 * Called after every message saved in a chat. Starts a waiting period for a
 * customer message; closes it when staff reply (D4: any staff member).
 */
const onMessage = async ({ conversation, sender, now = new Date() }) => {
  try {
    if (!conversation?.project || !TIMED_STATUSES.includes(conversation.project.status)) return;
    if (sender.role === ROLES.CUSTOMER) {
      if (isCustomerMember(conversation, sender._id)) await startWaiting(conversation, sender, now);
    } else if (conversation.members.some((m) => idStr(m.user) === String(sender._id))) {
      await resolveWaiting(conversation._id, sender._id, now);
    }
  } catch (err) {
    logger.error(`SLA hook failed for ${conversation?._id}: ${err.message}`);
  }
};

const startWaiting = async (conversation, customer, now) => {
  if (await ChatSla.exists({ conversation: conversation._id, open: true })) return; // clock already running

  const { hours, sla } = await getSlaSettings();
  const working = hoursUtil.isWorkingTime(now, hours);
  const clockStart = working ? now : hoursUtil.nextWorkingStart(now, hours);
  if (!clockStart) return; // no working days configured

  let period;
  try {
    period = await ChatSla.create({
      conversation: conversation._id,
      customer: customer._id,
      designer: conversation.project.leadDesigner,
      waitingSince: now,
      clockStart,
      afterHours: !working,
      autoReplyAt: hoursUtil.addWorkingMinutes(clockStart, sla.autoReplyMin, hours),
      remindAt: hoursUtil.addWorkingMinutes(clockStart, sla.remindMin, hours),
      escalateAt: hoursUtil.addWorkingMinutes(clockStart, sla.escalateMin, hours),
      nextCheckAt: hoursUtil.addWorkingMinutes(clockStart, sla.autoReplyMin, hours)
    });
  } catch (err) {
    if (err.code === 11000) return; // another message opened it at the same moment
    throw err;
  }

  if (!working) {
    // One "we're closed" notice, not one per message on a busy evening
    const recent = await ChatSla.exists({
      conversation: conversation._id,
      _id: { $ne: period._id },
      afterHours: true,
      waitingSince: { $gte: new Date(+now - AFTER_HOURS_NOTICE_GAP_MS) }
    });
    if (!recent) {
      const { lead } = await loadTeam(conversation);
      const who = lead ? firstName(lead.name) : "Your designer";
      await postNotice(
        conversation._id,
        conversation.project.leadDesigner,
        `Thanks for your message! Our team is available ${hoursUtil.describeHours(hours)}. ${who} will reply ${hoursUtil.describeWhen(clockStart, now, hours)}.`
      );
    }
  }
};

const resolveWaiting = async (conversationId, staffId, now) => {
  const period = await ChatSla.findOneAndUpdate(
    { conversation: conversationId, open: true },
    { $set: { open: false, resolvedAt: now, resolvedBy: staffId, resolution: "replied", nextCheckAt: null } },
    { new: true }
  );
  if (!period) return;
  const { hours } = await getSlaSettings();
  await ChatSla.updateOne({ _id: period._id }, { replyWorkingMs: hoursUtil.workingMsBetween(period.clockStart, now, hours) });
  closePopups(period);
};

const closePopups = (period) => {
  const payload = { slaId: String(period._id), conversationId: String(period.conversation) };
  emit((io) => {
    for (const u of period.remindedUsers || []) io.to(`user:${u}`).emit("sla:resolved", payload);
  });
};

// ── Monitor ──────────────────────────────────────────────────────────────────

/** Atomically moves a period from one stage to the next; returns the updated doc or null. */
const claim = (period, fromStage, set, extraFilter = {}) =>
  ChatSla.findOneAndUpdate({ _id: period._id, open: true, stage: fromStage, ...extraFilter }, { $set: set }, { new: true });

const closePeriod = async (period, now) => {
  const closed = await ChatSla.findOneAndUpdate(
    { _id: period._id, open: true },
    { $set: { open: false, resolvedAt: now, resolution: "closed", nextCheckAt: null } },
    { new: true }
  );
  if (closed) closePopups(closed);
};

const reminderPayload = (period, conversation, customerName, now, hours) => ({
  slaId: String(period._id),
  conversationId: String(conversation._id),
  projectName: conversation.name,
  customerName: firstName(customerName),
  waitingSince: period.waitingSince,
  waitingMinutes: Math.round(hoursUtil.workingMsBetween(period.clockStart, now, hours) / 60000),
  canSnooze: !period.snoozedUntil && period.stage === "reminded"
});

/** Runs every step that is due for one waiting period. */
const advance = async (initial, now) => {
  let period = initial;
  const conversation = await Conversation.findById(period.conversation).select("name members project");
  if (
    !conversation?.project ||
    !TIMED_STATUSES.includes(conversation.project.status) ||
    !isCustomerMember(conversation, period.customer)
  ) {
    return closePeriod(period, now);
  }

  const { hours } = await getSlaSettings();
  const team = await loadTeam(conversation);
  const customer = await User.findById(period.customer).select("name");
  const designerId = idStr(conversation.project.leadDesigner);

  // 15 min: tell the customer the designer is busy
  if (period.stage === "waiting" && now >= period.autoReplyAt) {
    const next = await claim(period, "waiting", { stage: "auto_replied", autoRepliedAt: now, nextCheckAt: period.remindAt, designer: designerId });
    if (next) {
      period = next;
      const lead = team.lead;
      const text =
        isOnLeave(lead, now) && team.backup
          ? `${firstName(lead.name)} is away today, so ${firstName(team.backup.name)} (backup designer) will reply shortly. Thank you for your patience 🙏`
          : `Your designer${lead ? ` ${firstName(lead.name)}` : ""} is currently busy with another task and will reply shortly. Thank you for your patience 🙏`;
      await postNotice(conversation._id, conversation.project.leadDesigner, text);
    } else {
      period = await ChatSla.findById(period._id);
      if (!period?.open) return;
    }
  }

  // 60 min: popup + notification for the designer (and the backup when the lead is away)
  if (period.stage === "auto_replied" && now >= period.remindAt) {
    const recipients = [];
    const leadAway = !team.lead || isOnLeave(team.lead, now) || team.lead.status !== "active";
    if (team.lead && !leadAway) recipients.push(idStr(team.lead));
    if (team.backup && team.backup.status === "active" && !isOnLeave(team.backup, now)) {
      const leadOnline = team.lead && !leadAway ? await isOnline(idStr(team.lead)) : false;
      if (leadAway || leadOnline === false) recipients.push(idStr(team.backup));
    }
    if (recipients.length === 0 && team.lead) recipients.push(idStr(team.lead)); // everyone away: still tell the lead

    const next = await claim(period, "auto_replied", {
      stage: "reminded",
      remindedAt: now,
      remindedUsers: recipients,
      nextCheckAt: period.escalateAt,
      designer: designerId
    });
    if (next) {
      period = next;
      const payload = reminderPayload(period, conversation, customer?.name, now, hours);
      await notify(recipients, {
        type: "sla_reminder",
        title: "A customer is waiting for a reply",
        message: `${payload.customerName} has been waiting ${payload.waitingMinutes} min in "${conversation.name}". Reply now.`,
        relatedConversation: conversation._id
      });
      emit((io) => recipients.forEach((u) => io.to(`user:${u}`).emit("sla:reminder", payload)));
    } else {
      period = await ChatSla.findById(period._id);
      if (!period?.open) return;
    }
  }

  // Snoozed reminder comes back once
  if (period.stage === "reminded" && period.snoozedUntil && !period.snoozeRepeatedAt && now >= period.snoozedUntil) {
    const next = await claim(
      period,
      "reminded",
      { snoozeRepeatedAt: now, nextCheckAt: period.escalateAt },
      { snoozeRepeatedAt: null }
    );
    if (next) {
      period = next;
      const payload = reminderPayload(period, conversation, customer?.name, now, hours);
      emit((io) => period.remindedUsers.forEach((u) => io.to(`user:${u}`).emit("sla:reminder", payload)));
    }
  }

  // 120 min: escalate to admin@bonito.in, the escalation contacts and the project manager
  if (period.stage === "reminded" && now >= period.escalateAt) {
    const contacts = await getEscalationRecipients();
    const recipients = [...new Set([...contacts.map((u) => String(u._id)), idStr(conversation.project.manager)].filter(Boolean))];
    if (recipients.length === 0) logger.warn(`SLA escalation for ${period._id} has no active recipients`);
    const next = await claim(period, "reminded", { stage: "escalated", escalatedAt: now, escalatedTo: recipients, nextCheckAt: null, designer: designerId });
    if (next) {
      period = next;
      const waited = Math.round(hoursUtil.workingMsBetween(period.clockStart, now, hours) / 60000);
      const leadName = team.lead?.name || "The lead designer";
      const payload = {
        slaId: String(period._id),
        conversationId: String(conversation._id),
        projectName: conversation.name,
        customerName: firstName(customer?.name),
        designerName: leadName,
        waitingMinutes: waited
      };
      await notify(recipients, {
        type: "sla_escalated",
        title: "Customer waiting over 2 hours",
        message: `${payload.customerName} has had no reply for ${waited} working minutes in "${conversation.name}" (lead: ${leadName}).`,
        relatedConversation: conversation._id
      });
      emit((io) => recipients.forEach((u) => io.to(`user:${u}`).emit("sla:escalated", payload)));
      emailEscalation(contacts, payload).catch((err) => logger.warn(`Escalation email failed: ${err.message}`));
    }
  }
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const emailEscalation = async (contacts, p) => {
  const { addEmailJob } = require("../jobs/queue");
  for (const u of contacts) {
    if (!u.email) continue;
    await addEmailJob({
      to: u.email,
      subject: `Escalation: customer waiting ${p.waitingMinutes} min — ${p.projectName}`,
      html: `<p>Hi ${escapeHtml(firstName(u.name))},</p>
        <p><strong>${escapeHtml(p.customerName)}</strong> has had no reply for <strong>${p.waitingMinutes} working minutes</strong>
        in the project chat <strong>${escapeHtml(p.projectName)}</strong>. Lead designer: ${escapeHtml(p.designerName)}.</p>
        <p>Please follow up with the team.</p>`
    });
  }
};

/**
 * Processes every open waiting period with a due step.
 * `filter` narrows the scan (used by tests).
 */
const processDue = async ({ now = new Date(), filter = {}, limit = 200 } = {}) => {
  const due = await ChatSla.find({ ...filter, open: true, nextCheckAt: { $lte: now } }).sort({ nextCheckAt: 1 }).limit(limit);
  await mapLimit(due, 10, async (period) => {
    try {
      await advance(period, now);
    } catch (err) {
      logger.error(`SLA step failed for ${period._id}: ${err.message}`);
    }
  });
  return due.length;
};

// ── Designer actions ─────────────────────────────────────────────────────────

/** Open reminders for this user (so a popup shows after a reload or on another device). */
const listPendingForUser = async (userId, now = new Date()) => {
  const periods = await ChatSla.find({ open: true, remindedUsers: userId, stage: { $in: ["reminded", "escalated"] } })
    .sort({ waitingSince: 1 })
    .limit(20);
  if (periods.length === 0) return [];
  const { hours } = await getSlaSettings();
  const convs = await Conversation.find({ _id: { $in: periods.map((p) => p.conversation) }, "members.user": userId }).select("name");
  const byConv = new Map(convs.map((c) => [String(c._id), c]));
  const customers = await User.find({ _id: { $in: periods.map((p) => p.customer) } }).select("name");
  const byCustomer = new Map(customers.map((c) => [String(c._id), c]));
  return periods
    .filter((p) => byConv.has(String(p.conversation)))
    .map((p) => ({
      ...reminderPayload(p, byConv.get(String(p.conversation)), byCustomer.get(String(p.customer))?.name, now, hours),
      escalated: p.stage === "escalated",
      snoozedUntil: p.snoozedUntil
    }));
};

/** "Snooze 10 min", allowed once per waiting period, only before escalation. */
const snooze = async (slaId, userId, now = new Date()) => {
  const current = await ChatSla.findOne({ _id: slaId, remindedUsers: userId });
  if (!current) throw new ApiError(404, "Reminder not found");
  if (!current.open) throw new ApiError(409, "This customer already has a reply");
  if (current.stage !== "reminded" || current.snoozedUntil) throw new ApiError(409, "This reminder can't be snoozed again");

  const until = new Date(+now + SNOOZE_MS);
  const updated = await ChatSla.findOneAndUpdate(
    { _id: slaId, open: true, stage: "reminded", snoozedUntil: null, remindedUsers: userId },
    { $set: { snoozedUntil: until, nextCheckAt: new Date(Math.min(+until, +current.escalateAt)) } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, "This reminder can't be snoozed again");
  emit((io) => updated.remindedUsers.forEach((u) => io.to(`user:${u}`).emit("sla:snoozed", { slaId: String(updated._id), snoozedUntil: until })));
  return { snoozedUntil: until };
};

// ── Metrics ──────────────────────────────────────────────────────────────────

/** Per-designer response metrics over the last `days` days. */
const getMetrics = async ({ days = 30, now = new Date() } = {}) => {
  const { sla } = await getSlaSettings();
  const since = new Date(+now - days * 24 * 60 * 60 * 1000);
  const fastMs = sla.autoReplyMin * 60 * 1000;
  const rows = await ChatSla.aggregate([
    { $match: { waitingSince: { $gte: since } } },
    {
      $group: {
        _id: "$designer",
        periods: { $sum: 1 },
        replied: { $sum: { $cond: [{ $eq: ["$resolution", "replied"] }, 1, 0] } },
        open: { $sum: { $cond: ["$open", 1, 0] } },
        avgReplyMs: { $avg: { $cond: [{ $eq: ["$resolution", "replied"] }, "$replyWorkingMs", null] } },
        fastReplies: { $sum: { $cond: [{ $and: [{ $eq: ["$resolution", "replied"] }, { $lte: ["$replyWorkingMs", fastMs] }] }, 1, 0] } },
        reminders: { $sum: { $cond: [{ $ne: ["$remindedAt", null] }, 1, 0] } },
        escalations: { $sum: { $cond: [{ $ne: ["$escalatedAt", null] }, 1, 0] } }
      }
    }
  ]);
  const designers = await User.find({ _id: { $in: rows.map((r) => r._id).filter(Boolean) } }).select("name avatarUrl designation");
  const byId = new Map(designers.map((d) => [String(d._id), d]));
  const ratings = await require("./rating.service").getAdminSummaries(rows.map((r) => r._id));
  return {
    days,
    fastThresholdMin: sla.autoReplyMin,
    designers: rows
      .map((r) => ({
        designer: byId.get(String(r._id)) || null,
        periods: r.periods,
        replied: r.replied,
        open: r.open,
        avgReplyMinutes: r.avgReplyMs == null ? null : Math.round(r.avgReplyMs / 60000),
        fastReplyRate: r.replied ? Math.round((r.fastReplies / r.replied) * 100) : null,
        reminders: r.reminders,
        escalations: r.escalations,
        rating: ratings.get(String(r._id)) || null
      }))
      .sort((a, b) => b.escalations - a.escalations || b.periods - a.periods)
  };
};

module.exports = { onMessage, processDue, listPendingForUser, snooze, getMetrics, isOnLeave };
