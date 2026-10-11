const Reminder = require("./models/Reminder");
const ApiError = require("../../utils/ApiError");
const logger = require("../../utils/logger");
const { mapLimit } = require("../../utils/mapLimit");
const { nextOccurrence, nextAfter, partsIn, isValidTimeZone } = require("./recurrence");
const { updateVersioned, removeOwned, assertBelowLimit, notifyDevices } = require("./versioned");

/**
 * Reminders (planner-module-plan.md, Phase 4).
 *
 * Scheduler: runs in the existing every-minute tick, once per organisation that has
 * the module (manifest `jobs`). One indexed query finds what is due ({status,
 * nextAt}); each reminder is then CLAIMED with an atomic lease (findOneAndUpdate
 * that only matches while unclaimed), exactly like offlineAlerts.service, so it is
 * sent once even with several servers. A server dying mid-send leaves the lease to
 * expire and the reminder is retried.
 *
 * What people receive is generic ("Reminder for 3:00 PM"): the text is encrypted
 * and the server can't read it.
 */
const MAX_ACTIVE = 1000;
const LEASE_MS = 5 * 60 * 1000;
const BATCH = 500;

const PUBLIC = (r) => ({
  _id: r._id,
  enc: r.enc,
  anchorAt: r.anchorAt,
  nextAt: r.nextAt,
  timeZone: r.timeZone,
  recurrence: r.recurrence,
  status: r.status,
  link: r.link?.kind ? r.link : null,
  lastFiredAt: r.lastFiredAt,
  version: r.version,
  updatedAt: r.updatedAt
});

const assertZone = (tz) => {
  if (tz && !isValidTimeZone(tz)) throw new ApiError(400, "Unknown time zone");
};

/** Keeps the day of the month a monthly reminder was set for (no drift). */
const withMonthDay = (recurrence, at, timeZone) =>
  recurrence?.freq === "monthly" ? { ...recurrence, monthDay: partsIn(at, timeZone).d } : recurrence;

// ── API ───────────────────────────────────────────────────────────────────────

const listReminders = async (owner, { status = "active" }) => {
  const q = Reminder.find({ owner, status });
  const rows = status === "active" ? await q.sort({ nextAt: 1 }).limit(MAX_ACTIVE).lean() : await q.sort({ updatedAt: -1 }).limit(200).lean();
  return rows.map(PUBLIC);
};

const createReminder = async (owner, { enc, at, timeZone = "Asia/Kolkata", recurrence, link }) => {
  assertZone(timeZone);
  await assertOwnLink(owner, link);
  await assertBelowLimit(Reminder, { owner, status: "active" }, MAX_ACTIVE, "active reminders");
  const r = await Reminder.create({
    owner,
    enc,
    anchorAt: at,
    nextAt: at,
    timeZone,
    recurrence: withMonthDay(recurrence, at, timeZone),
    link: link || undefined
  });
  notifyDevices(owner, { kind: "reminder", id: r._id });
  return PUBLIC(r);
};

const updateReminder = async (owner, id, { version, at, timeZone, recurrence, enc }) => {
  assertZone(timeZone);
  const set = {};
  if (enc) set.enc = enc;
  if (timeZone) set.timeZone = timeZone;
  if (at) Object.assign(set, { anchorAt: at, nextAt: at, status: "active", leaseUntil: null });
  if (recurrence) {
    const current = at && timeZone ? null : await Reminder.findOne({ _id: id, owner }).select("anchorAt timeZone").lean();
    set.recurrence = withMonthDay(recurrence, at || current?.anchorAt, timeZone || current?.timeZone || "Asia/Kolkata");
  }
  const r = await updateVersioned(Reminder, { id, owner, version, set });
  notifyDevices(owner, { kind: "reminder", id });
  return PUBLIC(r);
};

/** Fires again `minutes` from now; a repeating reminder keeps its schedule afterwards. */
const snooze = async (owner, id, { minutes }) => {
  const r = await Reminder.findOneAndUpdate(
    { _id: id, owner },
    { $set: { nextAt: new Date(Date.now() + minutes * 60 * 1000), status: "active", leaseUntil: null }, $inc: { version: 1 } },
    { new: true }
  ).lean();
  if (!r) throw new ApiError(404, "Not found");
  notifyDevices(owner, { kind: "reminder", id });
  return PUBLIC(r);
};

/** Done: a one-off reminder is finished; a repeating one moves to its next occurrence. */
const markDone = async (owner, id) => {
  const r = await Reminder.findOne({ _id: id, owner }).lean();
  if (!r) throw new ApiError(404, "Not found");
  const next = nextAfter(r.anchorAt, r.recurrence, r.timeZone);
  const set = next ? { anchorAt: next, nextAt: next, leaseUntil: null } : { status: "done", leaseUntil: null };
  const updated = await Reminder.findOneAndUpdate({ _id: id, owner }, { $set: set, $inc: { version: 1 } }, { new: true }).lean();
  notifyDevices(owner, { kind: "reminder", id });
  return PUBLIC(updated);
};

const deleteReminder = async (owner, id) => {
  await removeOwned(Reminder, { id, owner });
  notifyDevices(owner, { kind: "reminder", id, deleted: true });
};

// ── Scheduler ─────────────────────────────────────────────────────────────────

const timeLabel = (date, timeZone) =>
  new Intl.DateTimeFormat("en-IN", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(date);

const ownerHasPlanner = async (owner) => {
  const User = require("../../models/User");
  const modules = require("../../config/modules");
  const { effectiveUserMask } = require("../../services/moduleAccess.service");
  const { getEntitlements } = require("../../services/organisation.service");
  const { requireOrgId } = require("../../utils/tenantContext");
  const user = await User.findOne({ _id: owner, status: "active" }).select("role moduleAccess status").lean();
  if (!user) return false;
  const { mask, customerMask } = await getEntitlements(requireOrgId());
  return Boolean(effectiveUserMask(user, mask, customerMask) & modules.BIT.planner);
};

/** A reminder may only point at the owner's own note / todo, or a meeting they attend. */
const assertOwnLink = async (owner, link) => {
  if (!link) return;
  const Model = { note: require("./models/Note"), item: require("./models/TodoItem"), meeting: require("./models/Meeting") }[link.kind];
  const filter = link.kind === "meeting" ? { _id: link.id, "attendees.user": owner } : { _id: link.id, owner };
  if (!(await Model.exists(filter))) throw new ApiError(404, "That item wasn't found");
};

/** Claims one due reminder, tells its owner, and moves it on. */
const fire = async (r, now) => {
  const claimed = await Reminder.findOneAndUpdate(
    { _id: r._id, status: "active", nextAt: r.nextAt, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
    { $set: { leaseUntil: new Date(+now + LEASE_MS) } },
    { new: true }
  ).lean();
  if (!claimed) return false; // another server has it

  const { sendNotification } = require("../../services/notification.service");
  const isMeeting = claimed.link?.kind === "meeting";
  // Only if the owner can still use the Planner (e.g. a customer after it was closed to them)
  if (await ownerHasPlanner(claimed.owner)) await sendNotification({
    recipient: claimed.owner,
    type: "planner_reminder",
    title: isMeeting ? "Meeting soon" : "Reminder",
    // Generic on purpose: the reminder text is end-to-end encrypted
    message: isMeeting ? "One of your meetings is about to start. Open the Planner for details." : `Your reminder for ${timeLabel(claimed.nextAt, claimed.timeZone)}.`
  });

  // Repeating: next occurrence after now (one catch-up, never a burst); one-off: done
  const next = nextOccurrence(claimed.anchorAt, claimed.recurrence, claimed.timeZone);
  const upcoming = next && next > now ? next : nextAfter(claimed.anchorAt, claimed.recurrence, claimed.timeZone, now);
  // Conditional: a snooze or new time saved while this ran wins (and is not overwritten)
  await Reminder.updateOne(
    { _id: claimed._id, nextAt: claimed.nextAt, version: claimed.version },
    {
      $set: upcoming
        ? { anchorAt: upcoming, nextAt: upcoming, leaseUntil: null, lastFiredAt: now }
        : { status: "done", leaseUntil: null, lastFiredAt: now },
      $inc: { version: 1 }
    }
  );
  notifyDevices(claimed.owner, { kind: "reminder", id: claimed._id, fired: true });
  return true;
};

/** Every minute, per organisation (runs inside that organisation's context). */
const processDue = async (now = new Date()) => {
  const due = await Reminder.find({ status: "active", nextAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] })
    .sort({ nextAt: 1 })
    .limit(BATCH)
    .select("_id nextAt")
    .lean();
  let sent = 0;
  await mapLimit(due, 10, async (r) => {
    try {
      if (await fire(r, now)) sent += 1;
    } catch (err) {
      logger.error(`[PlannerReminders] ${r._id}: ${err.message}`);
    }
  });
  return sent;
};

module.exports = { listReminders, createReminder, updateReminder, snooze, markDone, deleteReminder, processDue, fire, MAX_ACTIVE };
