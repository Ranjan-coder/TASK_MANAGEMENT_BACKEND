const Meeting = require("./models/Meeting");
const User = require("../../models/User");
const Conversation = require("../../models/Conversation");
const ApiError = require("../../utils/ApiError");
const logger = require("../../utils/logger");
const modules = require("../../config/modules");
const { ROLES } = require("../../config/roles");
const { mapLimit } = require("../../utils/mapLimit");
const { effectiveUserMask } = require("../../services/moduleAccess.service");
const { notifyDevices } = require("./versioned");

/**
 * Meetings (planner-module-plan.md, Phase 5). The server sees times and people,
 * never the title, agenda or link (encrypted per meeting, see models/Meeting.js).
 */
const MAX_ATTENDEES = 50;
const MAX_LENGTH_MS = 24 * 3600 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const UPDATE_NOTICE_GAP_MS = 10 * 60 * 1000;
const sid = (v) => String(v);

const fmtWhen = (start, end, timeZone) => {
  const day = new Intl.DateTimeFormat("en-IN", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(start);
  const t = (d) => new Intl.DateTimeFormat("en-IN", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${day}, ${t(start)}–${t(end)}`;
};

/**
 * What a person sees: their own wrapped key only, plus the attendees' names and
 * answers. A customer never sees other customers (they may be from other projects):
 * those are only counted, as "guests".
 */
const viewFor = (m, me, people) => {
  const mine = m.attendees.find((a) => sid(a.user) === sid(me));
  const viewerIsCustomer = people.get(sid(me))?.role === ROLES.CUSTOMER;
  const visible = viewerIsCustomer
    ? m.attendees.filter((a) => sid(a.user) === sid(me) || people.get(sid(a.user))?.role !== ROLES.CUSTOMER)
    : m.attendees;
  return {
    _id: m._id,
    organiser: { _id: m.organiser, name: people.get(sid(m.organiser))?.name || "" },
    isOrganiser: sid(m.organiser) === sid(me),
    startAt: m.startAt,
    endAt: m.endAt,
    timeZone: m.timeZone,
    enc: m.enc,
    keyEpoch: m.keyEpoch,
    myKey: mine ? { wrapped: mine.wrapped, recipientKeyVersion: mine.recipientKeyVersion, senderKeyVersion: mine.senderKeyVersion } : null,
    myResponse: mine?.response || null,
    attendees: visible.map((a) => ({ user: a.user, name: people.get(sid(a.user))?.name || "", response: a.response })),
    hiddenGuests: m.attendees.length - visible.length,
    reminderMinutes: m.reminderMinutes,
    cancelled: m.cancelled,
    version: m.version,
    updatedAt: m.updatedAt
  };
};

const namesOf = async (meetings) => {
  const ids = [...new Set(meetings.flatMap((m) => [sid(m.organiser), ...m.attendees.map((a) => sid(a.user))]))];
  const users = await User.find({ _id: { $in: ids } }).select("name role").lean();
  return new Map(users.map((u) => [sid(u._id), { name: u.name, role: u.role }]));
};

const reminderAtOf = (startAt, minutes) => (minutes == null ? null : new Date(new Date(startAt).getTime() - minutes * 60 * 1000));

// ── Who may be invited ────────────────────────────────────────────────────────

/**
 * Every invitee: active, in this organisation (tenant-scoped query), able to use the
 * Planner, and — if a customer — only when the organisation opened it to customers
 * AND they share a project chat with the organiser.
 */
/**
 * Which of these people the organiser may involve (invite, or see busy times of):
 * active and able to use the Planner; customers only while the customer portal is on
 * and only from the organiser's own projects. One query for the people, one for the
 * projects, then Set lookups. Returns a Set of ids.
 */
const eligible = async (organiser, ids, req) => {
  const users = await User.find({ _id: { $in: ids }, status: "active", deletedAt: null }).select("role moduleAccess status deletedAt").lean();
  const customers = users.filter((u) => u.role === ROLES.CUSTOMER).map((u) => u._id);
  let projectCustomers = new Set();
  if (customers.length && req.orgModules & modules.BIT.customer_portal) {
    const convs = await Conversation.find({ "members.user": organiser._id, "project.customers": { $in: customers } }).select("project.customers").lean();
    projectCustomers = new Set(convs.flatMap((c) => (c.project?.customers || []).map(sid)));
  }
  return new Set(
    users
      .filter((u) => effectiveUserMask(u, req.orgModules, req.orgCustomerModules) & modules.BIT.planner)
      .filter((u) => u.role !== ROLES.CUSTOMER || projectCustomers.has(sid(u._id)))
      .map((u) => sid(u._id))
  );
};

const assertInvitable = async (organiser, userIds, req) => {
  const ids = [...new Set(userIds.map(sid))].filter((u) => u !== sid(organiser._id));
  if (ids.length > MAX_ATTENDEES) throw new ApiError(400, `At most ${MAX_ATTENDEES} people per meeting`);
  const ok = await eligible(organiser, ids, req);
  if (ids.some((u) => !ok.has(u))) {
    throw new ApiError(400, "Some of those people can't be invited (they need the Planner, and customers must be from your own projects)", [
      { code: "NOT_INVITABLE" }
    ]);
  }
  return ids;
};

const checkAttendeeWraps = (attendees, organiserId, invitedIds) => {
  const wrapped = new Set(attendees.map((a) => sid(a.user)));
  if (wrapped.size !== attendees.length) throw new ApiError(400, "Each person once, please");
  // Everyone invited (and the organiser) needs their copy of the key, nobody else
  const expected = new Set([sid(organiserId), ...invitedIds]);
  if (wrapped.size !== expected.size || [...expected].some((u) => !wrapped.has(u))) {
    throw new ApiError(400, "Every attendee needs their own copy of the meeting key", [{ code: "KEYS_MISMATCH" }]);
  }
};

const assertTimes = (startAt, endAt) => {
  if (!(endAt > startAt)) throw new ApiError(400, "The meeting must end after it starts");
  if (endAt - startAt > MAX_LENGTH_MS) throw new ApiError(400, "A meeting can last at most 24 hours");
};

// ── Notifications (generic: the details are encrypted) ────────────────────────

const tell = async (userIds, type, title, message) => {
  const { sendNotification } = require("../../services/notification.service");
  await mapLimit(userIds, 10, (u) => sendNotification({ recipient: u, type, title, message }).catch(() => {}));
};

const emailInvites = async (userIds, organiserName, when) => {
  const { addEmailJob } = require("../../jobs/queue");
  const users = await User.find({ _id: { $in: userIds } }).select("email name").lean();
  const esc = (v) => String(v || "").replace(/[<>&"]/g, "");
  await mapLimit(users, 5, (u) =>
    addEmailJob({
      to: u.email,
      subject: `Meeting invite from ${esc(organiserName)}`,
      html: `<p>Hi ${esc(u.name)},</p><p><strong>${esc(organiserName)}</strong> invited you to a meeting on <strong>${esc(when)}</strong>.</p><p>Open the Planner in the app to see the details and respond. (Details are end-to-end encrypted, so they aren't in this email.)</p>`
    }).catch(() => {})
  );
};

// ── API ───────────────────────────────────────────────────────────────────────

const listMeetings = async (me, { from, to }) => {
  // Interval overlap on the indexed (attendees.user, startAt): start < to AND end > from
  const rows = await Meeting.find({ "attendees.user": me, startAt: { $lt: to }, endAt: { $gt: from } }).sort({ startAt: 1 }).limit(500).lean();
  const names = await namesOf(rows);
  return rows.map((m) => viewFor(m, me, names));
};

const getMeeting = async (me, id) => {
  const m = await Meeting.findOne({ _id: id, "attendees.user": me }).lean();
  if (!m) throw new ApiError(404, "Not found");
  return viewFor(m, me, await namesOf([m]));
};

const createMeeting = async (req, { startAt, endAt, timeZone = "Asia/Kolkata", enc, attendees, reminderMinutes = 10 }) => {
  const organiser = req.user;
  if (organiser.role === ROLES.CUSTOMER) throw new ApiError(403, "Customers can be invited to meetings but can't organise them");
  assertTimes(startAt, endAt);
  const invited = await assertInvitable(organiser, attendees.map((a) => a.user), req);
  checkAttendeeWraps(attendees, organiser._id, invited);
  const ordered = [
    ...attendees.filter((a) => sid(a.user) === sid(organiser._id)).map((a) => ({ ...a, response: "accepted" })),
    ...attendees.filter((a) => sid(a.user) !== sid(organiser._id))
  ];
  const m = await Meeting.create({
    organiser: organiser._id,
    startAt,
    endAt,
    timeZone,
    enc,
    attendees: ordered,
    reminderMinutes,
    reminderAt: reminderAtOf(startAt, reminderMinutes)
  });
  const when = fmtWhen(startAt, endAt, timeZone);
  await tell(invited, "meeting_invite", "New meeting invite", `${organiser.name} invited you to a meeting on ${when}.`);
  emailInvites(invited, organiser.name, when).catch(() => {});
  for (const u of [sid(organiser._id), ...invited]) notifyDevices(u, { kind: "meeting", id: m._id });
  return viewFor(m.toObject(), organiser._id, await namesOf([m]));
};

/**
 * Organiser only. Changing who is invited must come with fresh keys for everyone
 * when someone is removed (rekey), so the removed person can't read later changes.
 */
const updateMeeting = async (req, id, { version, startAt, endAt, timeZone, enc, attendees, reminderMinutes, rekey }) => {
  const organiser = req.user;
  const m = await Meeting.findOne({ _id: id, organiser: organiser._id }).lean();
  if (!m) throw new ApiError(404, "Not found");
  if (m.cancelled) throw new ApiError(400, "This meeting was cancelled");
  // Only a real change of time counts (the app may send the same times with every save)
  const startChanged = Boolean(startAt) && +new Date(startAt) !== +new Date(m.startAt);
  const endChanged = Boolean(endAt) && +new Date(endAt) !== +new Date(m.endAt);
  const timeChanged = startChanged || endChanged;
  const start = startChanged ? startAt : m.startAt;
  const end = endChanged ? endAt : m.endAt;
  assertTimes(new Date(start), new Date(end));
  if (startChanged && new Date(startAt) < new Date()) throw new ApiError(400, "Choose a time in the future");

  const set = {};
  if (startChanged) set.startAt = startAt;
  if (endChanged) set.endAt = endAt;
  if (timeZone) set.timeZone = timeZone;
  if (enc) set.enc = enc;
  if (reminderMinutes !== undefined) set.reminderMinutes = reminderMinutes;
  const nextReminderAt = reminderAtOf(start, reminderMinutes !== undefined ? reminderMinutes : m.reminderMinutes);
  if (+(nextReminderAt || 0) !== +(m.reminderAt || 0)) {
    // The reminder moved, so it may go out again (only then)
    set.reminderAt = nextReminderAt;
    set.reminderSent = false;
  }

  const before = new Set(m.attendees.map((a) => sid(a.user)));
  let removed = [];
  let added = [];
  if (attendees) {
    const invited = await assertInvitable(organiser, attendees.map((a) => a.user), req);
    checkAttendeeWraps(attendees, organiser._id, invited);
    const after = new Set([sid(organiser._id), ...invited]);
    removed = [...before].filter((u) => !after.has(u));
    added = [...after].filter((u) => !before.has(u));
    if (removed.length && !(rekey && enc)) {
      throw new ApiError(400, "Removing someone needs a new meeting key and freshly encrypted details", [{ code: "REKEY_REQUIRED" }]);
    }
    const answers = new Map(m.attendees.map((a) => [sid(a.user), a.response]));
    set.attendees = attendees.map((a) => ({
      ...a,
      response: sid(a.user) === sid(organiser._id) ? "accepted" : timeChanged ? "pending" : answers.get(sid(a.user)) || "pending"
    }));
    if (rekey) set.keyEpoch = m.keyEpoch + 1;
  } else if (timeChanged) {
    // A new time asks everyone again
    set.attendees = m.attendees.map((a) => ({ ...a, response: sid(a.user) === sid(organiser._id) ? "accepted" : "pending" }));
  }

  const updated = await Meeting.findOneAndUpdate({ _id: id, organiser: organiser._id, version }, { $set: set, $inc: { version: 1 } }, { new: true }).lean();
  if (!updated) throw new ApiError(409, "This meeting was changed meanwhile. Reload and try again.", [{ code: "STALE_VERSION" }]);

  const when = fmtWhen(updated.startAt, updated.endAt, updated.timeZone);
  const stayed = updated.attendees.map((a) => sid(a.user)).filter((u) => u !== sid(organiser._id) && !added.includes(u));
  if (added.length) await tell(added, "meeting_invite", "New meeting invite", `${organiser.name} invited you to a meeting on ${when}.`);
  const quiet = m.lastUpdateNoticeAt && Date.now() - new Date(m.lastUpdateNoticeAt).getTime() < UPDATE_NOTICE_GAP_MS;
  if (stayed.length && (timeChanged || !quiet)) {
    await tell(stayed, "meeting_updated", "Meeting updated", `${organiser.name} updated a meeting (${when}).`);
    await Meeting.updateOne({ _id: id }, { $set: { lastUpdateNoticeAt: new Date() } });
  }
  if (removed.length) await tell(removed, "meeting_cancelled", "Removed from a meeting", `${organiser.name} removed you from a meeting (${when}).`);
  for (const u of new Set([...before, ...updated.attendees.map((a) => sid(a.user))])) notifyDevices(u, { kind: "meeting", id });
  return viewFor(updated, organiser._id, await namesOf([updated]));
};

const respond = async (me, id, response) => {
  const m = await Meeting.findOneAndUpdate(
    { _id: id, "attendees.user": me, organiser: { $ne: me }, cancelled: false },
    { $set: { "attendees.$.response": response }, $inc: { version: 1 } },
    { new: true }
  ).lean();
  if (!m) throw new ApiError(404, "Not found");
  notifyDevices(m.organiser, { kind: "meeting", id });
  notifyDevices(me, { kind: "meeting", id });
  return viewFor(m, me, await namesOf([m]));
};

/** Organiser cancels: kept (marked cancelled) so attendees see it, and told. */
const cancelMeeting = async (req, id) => {
  const m = await Meeting.findOneAndUpdate(
    { _id: id, organiser: req.user._id, cancelled: false },
    { $set: { cancelled: true, reminderAt: null }, $inc: { version: 1 } },
    { new: true }
  ).lean();
  if (!m) throw new ApiError(404, "Not found");
  const others = m.attendees.map((a) => sid(a.user)).filter((u) => u !== sid(req.user._id));
  await tell(others, "meeting_cancelled", "Meeting cancelled", `${req.user.name} cancelled the meeting on ${fmtWhen(m.startAt, m.endAt, m.timeZone)}.`);
  for (const u of [sid(req.user._id), ...others]) notifyDevices(u, { kind: "meeting", id });
};

// ── People you may invite ─────────────────────────────────────────────────────

const escapeRegex = (s) => String(s).slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Search for invitees (any staff member, not only admins, can use it): active staff
 * who have the Planner, plus — when the organisation opened it to customers — the
 * customers of the searcher's own projects. Returns names only, at most 20.
 */
const searchPeople = async (req, q = "") => {
  if (req.user.role === ROLES.CUSTOMER) throw new ApiError(403, "Not available");
  const rx = q ? { name: { $regex: escapeRegex(q), $options: "i" } } : {};
  // Colleagues with the Planner: the shared staff directory (database-filtered, staff only)
  const { people: staff } = await require("../../services/directory.service").searchStaff({
    q,
    module: "planner",
    orgMask: req.orgModules,
    excludeId: req.user._id,
    limit: 20
  });
  let customers = [];
  if (req.orgCustomerModules & modules.BIT.planner) {
    // One query for every project chat I'm in, then the customers of those projects (a Set: no duplicates)
    const convs = await Conversation.find({ "members.user": req.user._id, "project.customers.0": { $exists: true } }).select("project.customers").limit(500).lean();
    const ids = [...new Set(convs.flatMap((c) => (c.project?.customers || []).map(sid)))];
    if (ids.length) {
      customers = await User.find({ ...rx, _id: { $in: ids }, status: "active", deletedAt: null }).select("name role avatarUrl").limit(20).lean();
    }
  }
  return [...staff, ...customers]
    .slice(0, 20)
    .map((u) => ({ _id: u._id, name: u.name, role: u.role, designation: u.designation || "", avatarUrl: u.avatarUrl || "" }));
};

// ── Availability (busy times only) ────────────────────────────────────────────

/**
 * Merges overlapping intervals: sort by start, then one pass. O(k log k).
 * Returns [[start, end], ...] with no overlaps.
 */
const mergeIntervals = (intervals) => {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
};

/**
 * Busy times of colleagues between from and to: no titles, no other attendees,
 * nothing but merged start/end pairs (like a calendar's free/busy view).
 */
const availability = async (req, { users, from, to }) => {
  if (req.user.role === ROLES.CUSTOMER) throw new ApiError(403, "Not available");
  // Only people this person could invite (the same rule): no looking up anyone else
  const asked = [...new Set(users.map(sid))].filter((u) => u !== sid(req.user._id)).slice(0, MAX_ATTENDEES);
  const allowed = await eligible(req.user, asked, req);
  const ids = asked.filter((u) => allowed.has(u));
  const rows = await Meeting.find({ "attendees.user": { $in: ids }, cancelled: false, startAt: { $lt: to }, endAt: { $gt: from } })
    .select("startAt endAt attendees.user attendees.response")
    .lean();
  const byUser = new Map(ids.map((u) => [sid(u), []]));
  for (const m of rows) {
    for (const a of m.attendees) {
      if (a.response === "declined" || !byUser.has(sid(a.user))) continue;
      byUser.get(sid(a.user)).push([+m.startAt, +m.endAt]);
    }
  }
  return [...byUser].map(([user, list]) => ({ user, busy: mergeIntervals(list).map(([s, e]) => ({ start: new Date(s), end: new Date(e) })) }));
};

// ── Scheduler: one reminder per meeting, to everyone who hasn't declined ──────

/** Of these people, those who can still use the Planner now (e.g. customers after it was closed to them). */
const stillHasPlanner = async (userIds) => {
  const { getEntitlements } = require("../../services/organisation.service");
  const { requireOrgId } = require("../../utils/tenantContext");
  const { mask, customerMask } = await getEntitlements(requireOrgId());
  const users = await User.find({ _id: { $in: userIds }, status: "active" }).select("role moduleAccess status").lean();
  return users.filter((u) => effectiveUserMask(u, mask, customerMask) & modules.BIT.planner).map((u) => u._id);
};

const processDue = async (now = new Date()) => {
  const due = await Meeting.find({
    reminderSent: false,
    cancelled: false,
    reminderAt: { $ne: null, $lte: now },
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }]
  })
    .select("_id reminderAt")
    .limit(500)
    .lean();
  let sent = 0;
  await mapLimit(due, 10, async (row) => {
    try {
      const m = await Meeting.findOneAndUpdate(
        { _id: row._id, reminderSent: false, reminderAt: row.reminderAt, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
        { $set: { leaseUntil: new Date(+now + LEASE_MS) } },
        { new: true }
      ).lean();
      if (!m) return;
      // Skip reminders for meetings already over (e.g. the server was down)
      if (m.endAt > now) {
        const going = await stillHasPlanner(m.attendees.filter((a) => a.response !== "declined").map((a) => a.user));
        await tell(going, "planner_reminder", "Meeting soon", `Your meeting (${fmtWhen(m.startAt, m.endAt, m.timeZone)}) starts soon. Open the Planner for details.`);
        sent += 1;
      }
      // Conditional: if the organiser moved the meeting while this ran, the new reminder stays pending
      await Meeting.updateOne({ _id: m._id, reminderAt: m.reminderAt }, { $set: { reminderSent: true, leaseUntil: null } });
      await Meeting.updateOne({ _id: m._id, leaseUntil: { $ne: null } }, { $set: { leaseUntil: null } });
    } catch (err) {
      logger.error(`[PlannerMeetings] ${row._id}: ${err.message}`);
    }
  });
  return sent;
};

module.exports = { listMeetings, getMeeting, createMeeting, updateMeeting, respond, cancelMeeting, availability, searchPeople, mergeIntervals, processDue, MAX_ATTENDEES };
