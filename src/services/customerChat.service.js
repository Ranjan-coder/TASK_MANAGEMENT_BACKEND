/**
 * Customer experience in project chats (chat-features-plan.md P4):
 *  - the "usually replies in ~X" banner (from real reply times and the
 *    organisation's business hours)
 *  - team notes: a staff-only chat linked to each project chat
 */
const ApiError = require("../utils/ApiError");
const Conversation = require("../models/Conversation");
const ChatSla = require("../models/ChatSla");
const User = require("../models/User");
const tenant = require("../utils/tenantContext");
const hoursUtil = require("../utils/businessHours");
const { getSlaSettings } = require("./settings.service");
const { buildInitialKeyring, dropMemberKeys } = require("./groupKeys.service");
const { ROLES } = require("../config/roles");

// ── "Usually replies in ~X" ──────────────────────────────────────────────────

const REPLY_SAMPLE_DAYS = 30;
const MIN_SAMPLES = 5; // fewer replies than this: no claim is better than a wrong one
const REPLY_CACHE_MS = 10 * 60 * 1000;
const replyCache = new Map(); // org id → { at, minutes }

/** Median working-time reply (minutes) over the last 30 days, or null without enough data. */
const typicalReplyMinutes = async () => {
  const org = String(tenant.scope());
  const hit = replyCache.get(org);
  if (hit && Date.now() - hit.at < REPLY_CACHE_MS) return hit.minutes;
  const rows = await ChatSla.find({
    resolution: "replied",
    resolvedAt: { $gte: new Date(Date.now() - REPLY_SAMPLE_DAYS * 864e5) },
    replyWorkingMs: { $type: "number" }
  })
    .sort({ resolvedAt: -1 })
    .limit(500)
    .select("replyWorkingMs")
    .lean();
  let minutes = null;
  if (rows.length >= MIN_SAMPLES) {
    const sorted = rows.map((r) => r.replyWorkingMs).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    minutes = Math.max(1, Math.round(median / 60000));
  }
  if (replyCache.size > 1000) replyCache.clear();
  replyCache.set(org, { at: Date.now(), minutes });
  return minutes;
};

/** What a project chat's banner shows: open now?, hours, when the team is back, typical reply time. */
const serviceInfo = async (conversation, now = new Date()) => {
  if (!conversation.project) return { project: false };
  const { hours } = await getSlaSettings();
  const openNow = hoursUtil.isWorkingTime(now, hours);
  const nextOpen = openNow ? null : hoursUtil.nextWorkingStart(now, hours);
  return {
    project: true,
    openNow,
    hours: hoursUtil.describeHours(hours),
    backAt: nextOpen ? hoursUtil.describeWhen(nextOpen, now, hours) : null,
    typicalReplyMinutes: await typicalReplyMinutes()
  };
};

// ── Team notes ───────────────────────────────────────────────────────────────

const idOf = (v) => String(v?._id || v);

/**
 * Staff members of a project chat, with their role there: everyone who isn't
 * one of its customers, and (checked again on the accounts) never anyone
 * whose role is customer, even if the project's list were out of date.
 */
const staffOf = async (project) => {
  const customers = new Set((project.project?.customers || []).map(idOf));
  const candidates = project.members.filter((m) => m.user && !customers.has(idOf(m.user))).map((m) => ({ user: idOf(m.user), role: m.role }));
  const customerAccounts = new Set(
    (await User.find({ _id: { $in: candidates.map((m) => m.user) }, role: ROLES.CUSTOMER }).select("_id").lean()).map((u) => String(u._id))
  );
  return candidates.filter((m) => !customerAccounts.has(m.user));
};

/**
 * Opens (or creates) the team-notes chat of a project chat. Only staff of
 * that project; the requester's app sends the new group key wrapped for each
 * staff member, never for a customer.
 */
const openTeamNotes = async ({ project, user, encryptedGroupKeys }) => {
  if (!project.project) throw new ApiError(400, "Team notes belong to project chats");
  if (user.role === ROLES.CUSTOMER) throw new ApiError(403, "Team notes are for the project team");
  const staff = await staffOf(project);
  if (!staff.some((m) => m.user === idOf(user._id))) throw new ApiError(403, "Team notes are for the project team");

  if (project.internalNotes) {
    const existing = await Conversation.findById(project.internalNotes).select("_id").lean();
    if (existing) return { conversationId: String(existing._id), created: false };
  }
  if (!encryptedGroupKeys) throw new ApiError(400, "encryptedGroupKeys is required to start team notes", [{ code: "KEYS_REQUIRED" }]);
  if (staff.length < 2) throw new ApiError(400, "Team notes need at least two people on the project team", [{ code: "TEAM_TOO_SMALL" }]);

  const memberIds = staff.map((m) => m.user);
  let notes;
  try {
    notes = await Conversation.create({
      type: "group",
      name: `${project.name || "Project"} · Team notes`,
      createdBy: user._id,
      members: staff,
      // parseKeyMap refuses wraps for anyone who isn't one of these staff members
      groupKeyring: buildInitialKeyring({ keys: encryptedGroupKeys, creatorId: user._id, memberIdList: memberIds }),
      internalFor: project._id
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    notes = await Conversation.findOne({ internalFor: project._id }).select("_id"); // another staff member made it first
  }
  await Conversation.updateOne({ _id: project._id }, { $set: { internalNotes: notes._id } });
  // The team may have changed while this was being created (the members above came from a
  // snapshot): bring the notes in line with the project as it is now
  const fresh = await Conversation.findById(project._id);
  if (fresh) await syncTeamNotes(fresh);
  return { conversationId: String(notes._id), created: true };
};

/**
 * Keeps a project's team notes in step with its staff after the team changes:
 * removed staff lose access (their keys are dropped and a new key is
 * requested); new staff join and get the keys from a teammate's app.
 * Customers are never added.
 */
const syncTeamNotes = async (project) => {
  if (!project?.internalNotes) return null;
  const notes = await Conversation.findById(project.internalNotes);
  if (!notes) return null;
  const staff = await staffOf(project);
  const want = new Map(staff.map((m) => [m.user, m.role]));
  const had = new Set(notes.members.map((m) => idOf(m.user)));
  const removed = [...had].filter((id) => !want.has(id));
  const added = [...want.keys()].filter((id) => !had.has(id));
  if (!removed.length && !added.length && notes.members.every((m) => want.get(idOf(m.user)) === m.role)) return { removed, added };

  for (const uid of removed) dropMemberKeys(notes, uid);
  if (removed.length) notes.rekeyRequested = true;
  const kept = new Map(notes.members.map((m) => [idOf(m.user), m]));
  notes.members = staff.map((m) => {
    const prev = kept.get(m.user);
    return { user: m.user, role: m.role, joinedAt: prev?.joinedAt || new Date(), lastRead: prev?.lastRead || null, lastDelivered: prev?.lastDelivered || null };
  });
  // Groups normally need two members, but removing someone must never fail (they'd keep
  // access): a notes chat may shrink to one teammate and grow again later
  await notes.save({ validateBeforeSave: staff.length >= 2 });
  return { removed, added, notesId: String(notes._id) };
};

module.exports = { serviceInfo, typicalReplyMinutes, openTeamNotes, syncTeamNotes, staffOf };
