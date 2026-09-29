const OfflineAlert = require("../models/OfflineAlert");
const Conversation = require("../models/Conversation");
const User = require("../models/User");
const config = require("../config/env");
const logger = require("../utils/logger");
const { mapLimit } = require("../utils/mapLimit");
const { ROLES } = require("../config/roles");
const push = require("./push.service");
const { sendAlert, alertChannels } = require("./sms");

/**
 * "Your designer replied" alerts for customers who haven't seen a staff reply
 * in a project chat (R3 + R7). Nothing is sent while they're online or once
 * they've read it. Alerts contain the project name and a link, never text.
 *
 *   +2 min  unread & offline  → push to their installed app / browser
 *   +10 min still unread      → WhatsApp or SMS, only if they opted in
 * WhatsApp/SMS: at most one per chat every 3 hours, and never 21:00–08:00 IST
 * (held until 08:00).
 */
const PUSH_AFTER_MS = 2 * 60 * 1000;
const EXTERNAL_AFTER_MS = 10 * 60 * 1000;
const EXTERNAL_GAP_MS = 3 * 60 * 60 * 1000;
const QUIET_START = 21;
const QUIET_END = 8;
const IST_MS = 330 * 60 * 1000;

const idStr = (v) => (v ? String(v._id || v) : null);
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "Your designer";

/** Next moment outside quiet hours (IST). */
const outsideQuietHours = (date) => {
  const ist = new Date(+date + IST_MS);
  const h = ist.getUTCHours();
  if (h >= QUIET_END && h < QUIET_START) return date;
  const next = new Date(ist);
  if (h >= QUIET_START) next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(QUIET_END, 0, 0, 0);
  return new Date(+next - IST_MS);
};

const isOnline = async (userId) => {
  try {
    const io = require("../sockets").getIO();
    if (!io) return false;
    return (await io.in(`user:${userId}`).fetchSockets()).length > 0;
  } catch {
    return false;
  }
};

/** Called after a staff member's message in a project chat. */
const onStaffMessage = async ({ conversation, sender, now = new Date() }) => {
  try {
    if (!conversation?.project || sender.role === ROLES.CUSTOMER) return;
    const customers = conversation.project.customers.map(idStr).filter((c) => conversation.members.some((m) => idStr(m.user) === c));
    await Promise.all(
      customers.map((user) =>
        OfflineAlert.create({ user, conversation: conversation._id, sender: sender._id, since: now, dueAt: new Date(+now + PUSH_AFTER_MS) }).catch((err) => {
          if (err.code !== 11000) throw err; // one pending alert per chat is enough
        })
      )
    );
  } catch (err) {
    logger.error(`Offline alert scheduling failed: ${err.message}`);
  }
};

const finish = (alert, outcome) => OfflineAlert.updateOne({ _id: alert._id, status: "pending" }, { $set: { status: "done", outcome } });

const advance = async (alert, now) => {
  // Claim it so two servers never send the same alert
  const claimed = await OfflineAlert.findOneAndUpdate(
    { _id: alert._id, status: "pending", dueAt: { $lte: now } },
    { $set: { dueAt: new Date(+now + 5 * 60 * 1000) } },
    { new: false }
  );
  if (!claimed) return;

  const conv = await Conversation.findById(alert.conversation).select("name members project");
  const member = conv?.members.find((m) => idStr(m.user) === String(alert.user));
  if (!conv?.project || !member) return finish(alert, "left");
  if (member.lastRead && member.lastRead >= alert.since) return finish(alert, "read");
  if (await isOnline(alert.user)) return finish(alert, "online");

  const [customer, sender] = await Promise.all([
    User.findById(alert.user).select("status phone phoneVerified notificationPrefs"),
    User.findById(alert.sender).select("name")
  ]);
  if (!customer || customer.status !== "active") return finish(alert, "inactive");
  const vars = { designer: firstName(sender?.name), project: conv.name, url: `${config.clientUrl}/chat/${conv._id}` };

  if (alert.step === "push") {
    const delivered = await push.sendToUser(alert.user, {
      title: `${vars.designer} replied`,
      body: `New message in "${conv.name}". Tap to open.`,
      url: `/chat/${conv._id}`,
      tag: `chat-${conv._id}`
    });
    const wantsExternal = customer.phoneVerified && customer.phone && (customer.notificationPrefs?.whatsapp || customer.notificationPrefs?.sms);
    if (!wantsExternal) return finish(alert, delivered ? "push" : "no_channel");
    await OfflineAlert.updateOne(
      { _id: alert._id },
      { $set: { step: "external", dueAt: outsideQuietHours(new Date(+alert.since + EXTERNAL_AFTER_MS)), outcome: delivered ? "push" : "" } }
    );
    return;
  }

  // WhatsApp / SMS step
  const quietUntil = outsideQuietHours(now);
  if (+quietUntil > +now) {
    await OfflineAlert.updateOne({ _id: alert._id }, { $set: { dueAt: quietUntil } });
    return;
  }
  const recent = await OfflineAlert.exists({
    user: alert.user,
    conversation: alert.conversation,
    externalSentAt: { $gte: new Date(+now - EXTERNAL_GAP_MS) }
  });
  if (recent) return finish(alert, "throttled");

  const available = alertChannels();
  const prefs = customer.notificationPrefs || {};
  const channel = prefs.whatsapp && available.includes("whatsapp") ? "whatsapp" : prefs.sms && available.includes("sms") ? "sms" : null;
  if (!channel) return finish(alert, "no_channel");
  try {
    const used = await sendAlert({ phone: customer.phone, channel, vars });
    await OfflineAlert.updateOne({ _id: alert._id }, { $set: { status: "done", outcome: used || channel, externalSentAt: now } });
  } catch (err) {
    logger.warn(`Offline ${channel} alert failed: ${err.message}`);
    await finish(alert, "failed");
  }
};

const processDue = async ({ now = new Date(), filter = {}, limit = 200 } = {}) => {
  const due = await OfflineAlert.find({ ...filter, status: "pending", dueAt: { $lte: now } }).sort({ dueAt: 1 }).limit(limit);
  await mapLimit(due, 10, async (alert) => {
    try {
      await advance(alert, now);
    } catch (err) {
      logger.error(`Offline alert ${alert._id} failed: ${err.message}`);
    }
  });
  return due.length;
};

module.exports = { onStaffMessage, processDue, outsideQuietHours };
