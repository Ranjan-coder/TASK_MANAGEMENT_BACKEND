const crypto = require("crypto");
const ModerationTerm = require("../models/ModerationTerm");
const ModerationIncident = require("../models/ModerationIncident");
const ModerationStat = require("../models/ModerationStat");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const Report = require("../models/Report");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { normalizeTerm, SEVERITY_RANK } = require("../utils/moderationText");
const { getSlaSettings, getEscalationRecipients } = require("./settings.service");
const SEED = require("../config/moderationLexicon.seed");

/**
 * Abuse alerts for project chats (plan §6.4). The check itself runs on the
 * sender's device; when they choose "Send anyway" the message carries
 * { flagged, severity, hitCount } in the clear (text stays encrypted). Here
 * we count those flags over the recent-message window and alert admins.
 */

const WARNING_TEXT =
  "⚠️ This conversation is moving towards abusive language. Please keep it respectful. This chat has been flagged for review by Bonito management.";
const MAX_HITS_PER_MESSAGE = 20;
const LEXICON_CACHE_MS = 60 * 1000;

const idStr = (v) => (v ? String(v._id || v) : null);
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "Someone";
const today = () => new Date().toISOString().slice(0, 10);

const emit = (fn) => {
  try {
    const io = require("../sockets").getIO();
    if (io) fn(io);
  } catch (err) {
    logger.warn(`Moderation socket event skipped: ${err.message}`);
  }
};

const notify = async (recipients, payload) => {
  const { sendNotification } = require("./notification.service");
  await Promise.all(
    [...new Set(recipients.filter(Boolean).map(String))].map((recipient) =>
      sendNotification({ recipient, type: "moderation_alert", ...payload }).catch((err) =>
        logger.warn(`Moderation notification failed: ${err.message}`)
      )
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

const bumpStat = (field) =>
  ModerationStat.updateOne({ day: today() }, { $inc: { [field]: 1 } }, { upsert: true }).catch((err) =>
    logger.warn(`Moderation stat failed: ${err.message}`)
  );

// ── Word list ────────────────────────────────────────────────────────────────

let lexiconCache = null;
let lexiconAt = 0;

const ensureSeeded = async () => {
  if (await ModerationTerm.exists({})) return;
  const docs = [];
  const seen = new Set();
  for (const s of SEED) {
    const term = normalizeTerm(s.term);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    docs.push({ term, display: s.term, severity: s.severity, language: s.language });
  }
  try {
    await ModerationTerm.insertMany(docs, { ordered: false });
    logger.info(`[Moderation] word list seeded with ${docs.length} terms`);
  } catch (err) {
    if (err.code !== 11000) throw err; // another server seeded at the same time
  }
};

/** The active word list for devices: { version, terms: [{ t, s }] }. */
const getLexicon = async () => {
  if (lexiconCache && Date.now() - lexiconAt < LEXICON_CACHE_MS) return lexiconCache;
  await ensureSeeded();
  const terms = await ModerationTerm.find({ active: true }).select("term severity").sort({ term: 1 }).lean();
  const list = terms.map((t) => ({ t: t.term, s: t.severity }));
  const version = crypto.createHash("sha256").update(JSON.stringify(list)).digest("base64url").slice(0, 16);
  lexiconCache = { version, terms: list };
  lexiconAt = Date.now();
  return lexiconCache;
};

const clearLexiconCache = () => {
  lexiconCache = null;
};

const listTermsForAdmin = async () => {
  await ensureSeeded();
  return ModerationTerm.find().sort({ severity: -1, display: 1 }).populate("createdBy", "name").lean();
};

const addTerm = async ({ display, severity, language }, actorId) => {
  const term = normalizeTerm(display);
  if (term.replace(/ /g, "").length < 2) throw new ApiError(400, "That word is too short to check reliably");
  try {
    const doc = await ModerationTerm.create({ term, display: display.trim(), severity, language, createdBy: actorId });
    clearLexiconCache();
    return doc;
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, "That word (or a spelling of it) is already on the list");
    throw err;
  }
};

const updateTerm = async (id, patch) => {
  const doc = await ModerationTerm.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
  if (!doc) throw new ApiError(404, "Word not found");
  clearLexiconCache();
  return doc;
};

const deleteTerm = async (id) => {
  const doc = await ModerationTerm.findByIdAndDelete(id);
  if (!doc) throw new ApiError(404, "Word not found");
  clearLexiconCache();
  return doc;
};

// ── Flags on messages ────────────────────────────────────────────────────────

/**
 * Validates the device's flag. Only project-chat text messages can carry one;
 * values outside the limits are refused rather than trusted.
 */
const parseModeration = (input, { messageType, conversation }) => {
  if (!input || input.flagged !== true) return undefined;
  if (messageType !== "text" || !conversation?.project) return undefined;
  const hitCount = Number(input.hitCount);
  if (!Number.isInteger(hitCount) || hitCount < 1 || hitCount > MAX_HITS_PER_MESSAGE || !SEVERITY_RANK[input.severity]) {
    throw new ApiError(400, "Invalid moderation flag");
  }
  return { flagged: true, severity: input.severity, hitCount };
};

const maxSeverity = (a, b) => (!a ? b : !b ? a : SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

/** Flagged-word totals per sender over the counted window. */
const windowTotals = async (conversation, windowSize) => {
  const q = { conversation: conversation._id, type: "text" };
  if (conversation.moderation?.countFrom) q.createdAt = { $gte: conversation.moderation.countFrom };
  const recent = await Message.find(q).sort({ createdAt: -1 }).limit(windowSize).select("sender moderation createdAt").lean();
  const bySender = new Map();
  let total = 0;
  let severity = null;
  let first = null;
  for (const m of recent) {
    const hits = m.moderation?.flagged ? m.moderation.hitCount || 0 : 0;
    if (!hits) continue;
    total += hits;
    severity = maxSeverity(severity, m.moderation.severity);
    first = !first || m.createdAt < first ? m.createdAt : first;
    const cur = bySender.get(String(m.sender)) || { user: m.sender, hits: 0, messages: 0 };
    cur.hits += hits;
    cur.messages += 1;
    bySender.set(String(m.sender), cur);
  }
  return { total, severity, first, offenders: [...bySender.values()] };
};

const describeOffenders = async (offenders) => {
  const users = await User.find({ _id: { $in: offenders.map((o) => o.user) } }).select("name role");
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return offenders
    .sort((a, b) => b.hits - a.hits)
    .map((o) => {
      const u = byId.get(String(o.user));
      return `${u?.name || "Someone"}${u?.role === "customer" ? " (customer)" : ""}: ${o.hits}`;
    })
    .join(", ");
};

const alertAdmins = async (incident, conversation, { reason }) => {
  const contacts = await getEscalationRecipients();
  const manager = idStr(conversation.project?.manager);
  const offenderIds = new Set(incident.offenders.map((o) => String(o.user)));
  const recipients = [...contacts.map((u) => String(u._id)), manager].filter((id) => id && !offenderIds.has(id));
  const who = await describeOffenders(incident.offenders);
  const title = incident.severity === "threat" ? "⚠️ Threat in a project chat" : "⚠️ Abusive language in a project chat";
  const message = `"${conversation.name}" — ${reason}. Flagged words by: ${who}.`;
  await notify(recipients, { title, message });
  emit((io) => recipients.forEach((u) => io.to(`user:${u}`).emit("moderation:alert", { incidentId: String(incident._id), conversationId: String(conversation._id), title, message })));

  const { addEmailJob } = require("../jobs/queue");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  for (const u of contacts) {
    if (!u.email || offenderIds.has(String(u._id))) continue;
    addEmailJob({
      to: u.email,
      subject: `${title}: ${conversation.name}`,
      html: `<p>Hi ${esc(firstName(u.name))},</p><p>${esc(message)}</p>
        <p>Open Admin → Moderation to review. Message text stays end-to-end encrypted; you can ask the participants to submit a verified report.</p>`
    }).catch((err) => logger.warn(`Moderation email failed: ${err.message}`));
  }
};

/**
 * Runs after a project-chat text message is saved or edited.
 * @param {object} p
 * @param {object} p.conversation  must include project, moderation, name
 * @param {object} p.sender
 * @param {number} p.newHits       flagged words added by this message/edit (0 if none)
 * @param {string} [p.severity]
 * @param {boolean} [p.isEdit]
 */
const afterTextMessage = async ({ conversation, sender, newHits = 0, severity, isEdit = false, now = new Date() }) => {
  if (!conversation?.project) return;
  try {
    const { settings } = await getSlaSettings();
    const threshold = settings.moderation?.threshold || 5;
    const windowSize = settings.moderation?.window || 50;
    const fresh = await Conversation.findById(conversation._id).select("name project moderation");
    if (!fresh) return;
    if (newHits > 0 && !isEdit) bumpStat("sentAnyway");

    const openId = fresh.moderation?.openIncident;
    if (openId) {
      if (newHits > 0) {
        const incident = await ModerationIncident.findById(openId);
        if (!incident) return;
        incident.hitCount += newHits;
        incident.lastFlagAt = now;
        const o = incident.offenders.find((x) => String(x.user) === String(sender._id));
        if (o) {
          o.hits += newHits;
          o.messages += 1;
        } else incident.offenders.push({ user: sender._id, hits: newHits, messages: 1 });
        const becameThreat = severity === "threat" && incident.severity !== "threat";
        incident.severity = maxSeverity(incident.severity, severity);
        await incident.save();
        // A threat is worth a second alert even during the cooldown
        if (becameThreat) await alertAdmins(incident, fresh, { reason: "a threat was sent in a chat already under review" });
      } else if (!isEdit) {
        // Cooldown ends after `window` text messages with no flags
        const incident = await ModerationIncident.findById(openId).select("lastFlagAt createdAt");
        const since = incident?.lastFlagAt || incident?.createdAt || now;
        const clean = await Message.countDocuments({ conversation: fresh._id, type: "text", createdAt: { $gt: since } });
        if (clean >= windowSize) {
          await Conversation.updateOne(
            { _id: fresh._id, "moderation.openIncident": openId },
            { $set: { "moderation.openIncident": null, "moderation.countFrom": now } }
          );
        }
      }
      return;
    }

    if (newHits === 0) return;
    const totals = await windowTotals(fresh, windowSize);
    const isThreat = severity === "threat";
    if (!isThreat && totals.total < threshold) return;

    const incident = await ModerationIncident.create({
      conversation: fresh._id,
      trigger: isThreat ? "threat" : "threshold",
      severity: maxSeverity(totals.severity, severity) || "abusive",
      hitCount: totals.total,
      windowSize,
      threshold,
      offenders: totals.offenders,
      firstFlagAt: totals.first,
      lastFlagAt: now
    });
    // Claim the chat so two messages arriving together raise one alert
    const claimed = await Conversation.findOneAndUpdate(
      { _id: fresh._id, "moderation.openIncident": null },
      { $set: { "moderation.openIncident": incident._id, "moderation.warningAt": now } },
      { new: true }
    );
    if (!claimed) {
      await ModerationIncident.deleteOne({ _id: incident._id });
      return;
    }
    await postNotice(fresh._id, sender._id, WARNING_TEXT);
    emit((io) =>
      io.to(`conv:${fresh._id}`).emit("moderation:warning", { conversationId: String(fresh._id), incidentId: String(incident._id), at: now })
    );
    await alertAdmins(incident, fresh, {
      reason: isThreat ? "a threat was sent" : `${totals.total} flagged words in the last ${windowSize} messages`
    });
  } catch (err) {
    logger.error(`Moderation check failed for ${conversation?._id}: ${err.message}`);
  }
};

const recordPrevented = () => bumpStat("prevented");

// ── Admin ────────────────────────────────────────────────────────────────────

const PERSON = "name email phone role avatarUrl";

const listIncidents = async ({ status }) => {
  const q = status ? { status } : {};
  const [items, counts] = await Promise.all([
    ModerationIncident.find(q)
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("conversation", "name project.status")
      .populate("offenders.user", "name role"),
    ModerationIncident.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])
  ]);
  return { items, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
};

const getIncident = async (id) => {
  const incident = await ModerationIncident.findById(id)
    .populate("conversation", "name project members")
    .populate("offenders.user", PERSON)
    .populate("resolvedBy", "name");
  if (!incident) throw new ApiError(404, "Alert not found");
  const conv = incident.conversation;
  const teamIds = conv?.project
    ? [conv.project.leadDesigner, conv.project.backupDesigner, conv.project.manager, ...conv.project.customers].filter(Boolean)
    : [];
  const team = await User.find({ _id: { $in: teamIds } }).select(PERSON).lean();
  const reports = await Report.find({ conversation: conv?._id, createdAt: { $gte: new Date(+incident.createdAt - 7 * 24 * 3600 * 1000) } })
    .select("ticketNo status reason reporter reportedUser createdAt")
    .populate("reporter", "name")
    .populate("reportedUser", "name")
    .sort({ createdAt: -1 });
  const obj = incident.toObject();
  return {
    ...obj,
    conversation: conv ? { _id: conv._id, name: conv.name, status: conv.project?.status, memberCount: conv.members.length } : null,
    team: team.map((u) => ({
      ...u,
      projectRole:
        String(u._id) === idStr(conv.project.leadDesigner)
          ? "Lead designer"
          : String(u._id) === idStr(conv.project.backupDesigner)
            ? "Backup designer"
            : String(u._id) === idStr(conv.project.manager)
              ? "Project manager"
              : "Customer"
    })),
    reports
  };
};

const resolveIncident = async (id, admin, note = "") => {
  const incident = await ModerationIncident.findOneAndUpdate(
    { _id: id, status: "open" },
    { $set: { status: "resolved", resolvedBy: admin._id, resolvedAt: new Date(), resolutionNote: note } },
    { new: true }
  );
  if (!incident) throw new ApiError(409, "This alert is already resolved");
  // New flags start counting afresh; a new alert can be raised again
  await Conversation.updateOne(
    { _id: incident.conversation, "moderation.openIncident": incident._id },
    { $set: { "moderation.openIncident": null, "moderation.countFrom": new Date() } }
  );
  return incident;
};

/** Asks the chat's members to report what happened (admins can't read the chat themselves). */
const requestEvidence = async (id, admin) => {
  const incident = await ModerationIncident.findOneAndUpdate(
    { _id: id, evidenceRequestedAt: null },
    { $set: { evidenceRequestedAt: new Date() } },
    { new: true }
  );
  if (!incident) throw new ApiError(409, "Evidence was already requested for this alert");
  const conv = await Conversation.findById(incident.conversation).select("name members");
  if (!conv) return incident;
  await postNotice(
    conv._id,
    admin._id,
    "Bonito management has asked anyone affected to report the messages concerned, using the ⚑ button above. Only the messages you choose are shared."
  );
  const { sendNotification } = require("./notification.service");
  await Promise.all(
    conv.members.map((m) =>
      sendNotification({
        recipient: m.user,
        type: "moderation_alert",
        title: "Please help us review a conversation",
        message: `If anything in "${conv.name}" upset you, please report it with the ⚑ button in the chat.`,
        relatedConversation: conv._id
      }).catch(() => {})
    )
  );
  return incident;
};

const getStats = async (days = 30) => {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = await ModerationStat.find({ day: { $gte: since } }).lean();
  return {
    days,
    prevented: rows.reduce((a, r) => a + (r.prevented || 0), 0),
    sentAnyway: rows.reduce((a, r) => a + (r.sentAnyway || 0), 0)
  };
};

module.exports = {
  WARNING_TEXT,
  getLexicon,
  clearLexiconCache,
  listTermsForAdmin,
  addTerm,
  updateTerm,
  deleteTerm,
  parseModeration,
  afterTextMessage,
  recordPrevented,
  listIncidents,
  getIncident,
  resolveIncident,
  requestEvidence,
  getStats,
  ensureSeeded
};
