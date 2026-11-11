const Note = require("./models/Note");
const PlannerVault = require("./models/PlannerVault");
const ApiError = require("../../utils/ApiError");
const { updateVersioned, removeOwned, assertBelowLimit, cursorPage, notifyDevices } = require("./versioned");

const MAX_NOTES = 5000;

// ── Vault (the person's wrapped planner key) ──────────────────────────────────

const getVault = async (owner) => (await PlannerVault.findOne({ user: owner }).select("wraps").lean())?.wraps || null;

/**
 * Adds the key wrapped for one chat-key version. Append-only: an existing wrap is
 * never replaced, so a stolen session can't swap the key and make notes unreadable.
 */
const addVaultWrap = async (owner, { keyVersion, wrapped }) => {
  const res = await PlannerVault.updateOne(
    { user: owner, "wraps.keyVersion": { $ne: keyVersion } },
    { $push: { wraps: { keyVersion, wrapped } } },
    { upsert: true }
  ).catch((err) => {
    if (err.code === 11000) return { matchedCount: 0, upsertedCount: 0 }; // that version is already wrapped
    throw err;
  });
  if (!res.matchedCount && !res.upsertedCount) throw new ApiError(409, "The planner key is already set for this key version", [{ code: "VAULT_EXISTS" }]);
  return getVault(owner);
};

// ── Notes ─────────────────────────────────────────────────────────────────────

const PUBLIC = (n) => ({ _id: n._id, enc: n.enc, pinned: n.pinned, color: n.color, archived: n.archived, version: n.version, updatedAt: n.updatedAt, createdAt: n.createdAt });

const listNotes = async (owner, { archived = false, cursor, limit }) => {
  const page = await cursorPage(Note, { owner, archived }, { cursor, limit });
  return { items: page.items.map(PUBLIC), nextCursor: page.nextCursor };
};

const createNote = async (owner, { enc, pinned = false, color = "none" }) => {
  await assertBelowLimit(Note, { owner }, MAX_NOTES, "notes");
  const note = await Note.create({ owner, enc, pinned, color });
  notifyDevices(owner, { kind: "note", id: note._id, version: note.version });
  return PUBLIC(note);
};

const updateNote = async (owner, id, { version, ...set }) => {
  const note = await updateVersioned(Note, { id, owner, version, set });
  notifyDevices(owner, { kind: "note", id, version: note.version });
  return PUBLIC(note);
};

const deleteNote = async (owner, id) => {
  await removeOwned(Note, { id, owner });
  notifyDevices(owner, { kind: "note", id, deleted: true });
};

/**
 * Start over: the person's planner key can no longer be opened (e.g. a password
 * reset wiped their keys and they have no recovery key). Their encrypted items
 * are unreadable to everyone, so they are deleted together with the key.
 * Meetings they were invited to stay (those use per-meeting keys).
 */
const resetVault = async (owner) => {
  const TodoList = require("./models/TodoList");
  const TodoItem = require("./models/TodoItem");
  const Reminder = require("./models/Reminder");
  const [notes, lists, items, reminders] = await Promise.all([
    Note.deleteMany({ owner }),
    TodoList.deleteMany({ owner }),
    TodoItem.deleteMany({ owner }),
    Reminder.deleteMany({ owner, "link.kind": { $ne: "meeting" } })
  ]);
  await PlannerVault.deleteOne({ user: owner });
  notifyDevices(owner, { kind: "vault", reset: true });
  return { notes: notes.deletedCount, lists: lists.deletedCount, items: items.deletedCount, reminders: reminders.deletedCount };
};

module.exports = { resetVault, getVault, addVaultWrap, listNotes, createNote, updateNote, deleteNote, MAX_NOTES };
