const TodoList = require("./models/TodoList");
const TodoItem = require("./models/TodoItem");
const ApiError = require("../../utils/ApiError");
const { between, spread, needsRebalance } = require("./rank");
const { updateVersioned, removeOwned, assertBelowLimit, notifyDevices } = require("./versioned");

const MAX_LISTS = 200;
const MAX_ITEMS_PER_LIST = 2000;

const PUBLIC_LIST = (l) => ({ _id: l._id, enc: l.enc, rank: l.rank, version: l.version, updatedAt: l.updatedAt });
const PUBLIC_ITEM = (i) => ({
  _id: i._id,
  list: i.list,
  enc: i.enc,
  done: i.done,
  doneAt: i.doneAt,
  dueAt: i.dueAt,
  rank: i.rank,
  version: i.version,
  updatedAt: i.updatedAt
});

// ── Ordering ──────────────────────────────────────────────────────────────────

/** Rank after the current last one (one indexed lookup). */
const rankAtEnd = async (Model, filter) => {
  const last = await Model.findOne(filter).sort({ rank: -1 }).select("rank").lean();
  return between(last?.rank || "", null);
};

/**
 * Rank between two neighbours given by id (either may be absent: start / end).
 * Refused if they are no longer in that order (someone reordered meanwhile).
 */
const rankBetween = async (Model, filter, beforeId, afterId) => {
  const [before, after] = await Promise.all([
    beforeId ? Model.findOne({ ...filter, _id: beforeId }).select("rank").lean() : null,
    afterId ? Model.findOne({ ...filter, _id: afterId }).select("rank").lean() : null
  ]);
  if ((beforeId && !before) || (afterId && !after)) throw new ApiError(404, "Not found");
  if (before && after && before.rank >= after.rank) {
    throw new ApiError(409, "The order changed on another device. Reload and try again.", [{ code: "STALE_ORDER" }]);
  }
  return between(before?.rank || "", after?.rank ?? null);
};

/** Rare: keys got long after many moves into one gap; respace the whole list in one bulk write. */
const rebalance = async (Model, filter) => {
  const rows = await Model.find(filter).sort({ rank: 1 }).select("_id").lean();
  const keys = spread(rows.length);
  await Model.bulkWrite(rows.map((r, i) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { rank: keys[i] } } } })));
};

// ── Lists ─────────────────────────────────────────────────────────────────────

const listLists = async (owner) => (await TodoList.find({ owner }).sort({ rank: 1 }).limit(MAX_LISTS).lean()).map(PUBLIC_LIST);

const createList = async (owner, { enc }) => {
  await assertBelowLimit(TodoList, { owner }, MAX_LISTS, "lists");
  const list = await TodoList.create({ owner, enc, rank: await rankAtEnd(TodoList, { owner }) });
  notifyDevices(owner, { kind: "list", id: list._id });
  return PUBLIC_LIST(list);
};

const updateList = async (owner, id, { version, enc }) => {
  const list = await updateVersioned(TodoList, { id, owner, version, set: { enc } });
  notifyDevices(owner, { kind: "list", id });
  return PUBLIC_LIST(list);
};

const moveList = async (owner, id, { before, after }) => {
  const rank = await rankBetween(TodoList, { owner }, before, after);
  const list = await TodoList.findOneAndUpdate({ _id: id, owner }, { $set: { rank }, $inc: { version: 1 } }, { new: true }).lean();
  if (!list) throw new ApiError(404, "Not found");
  if (needsRebalance(rank)) await rebalance(TodoList, { owner });
  notifyDevices(owner, { kind: "list", id });
  return PUBLIC_LIST(list);
};

const deleteList = async (owner, id) => {
  await removeOwned(TodoList, { id, owner });
  await TodoItem.deleteMany({ owner, list: id });
  notifyDevices(owner, { kind: "list", id, deleted: true });
};

// ── Items ─────────────────────────────────────────────────────────────────────

const ownList = async (owner, listId) => {
  if (!(await TodoList.exists({ _id: listId, owner }))) throw new ApiError(404, "List not found");
};

const listItems = async (owner, listId) => {
  await ownList(owner, listId);
  return (await TodoItem.find({ owner, list: listId }).sort({ rank: 1 }).limit(MAX_ITEMS_PER_LIST).lean()).map(PUBLIC_ITEM);
};

/** Open items due in [from, to) across every list (Today / overdue), from one index. */
const dueItems = async (owner, { from, to }) =>
  (await TodoItem.find({ owner, done: false, dueAt: { $gte: from, $lt: to } }).sort({ dueAt: 1 }).limit(200).lean()).map(PUBLIC_ITEM);

const createItem = async (owner, listId, { enc, dueAt = null }) => {
  await ownList(owner, listId);
  await assertBelowLimit(TodoItem, { owner, list: listId }, MAX_ITEMS_PER_LIST, "items in this list");
  const item = await TodoItem.create({ owner, list: listId, enc, dueAt, rank: await rankAtEnd(TodoItem, { owner, list: listId }) });
  notifyDevices(owner, { kind: "item", id: item._id, list: listId });
  return PUBLIC_ITEM(item);
};

const updateItem = async (owner, id, { version, done, ...rest }) => {
  const set = { ...rest };
  if (done !== undefined) {
    set.done = done;
    set.doneAt = done ? new Date() : null;
  }
  const item = await updateVersioned(TodoItem, { id, owner, version, set });
  notifyDevices(owner, { kind: "item", id, list: item.list });
  return PUBLIC_ITEM(item);
};

/** Moves an item between two neighbours, optionally into another of the person's lists. */
const moveItem = async (owner, id, { before, after, list }) => {
  const item = await TodoItem.findOne({ _id: id, owner }).select("list").lean();
  if (!item) throw new ApiError(404, "Not found");
  const target = list || String(item.list);
  if (list) await ownList(owner, list);
  const rank = await rankBetween(TodoItem, { owner, list: target }, before, after);
  const moved = await TodoItem.findOneAndUpdate({ _id: id, owner }, { $set: { rank, list: target }, $inc: { version: 1 } }, { new: true }).lean();
  if (needsRebalance(rank)) await rebalance(TodoItem, { owner, list: target });
  notifyDevices(owner, { kind: "item", id, list: target });
  return PUBLIC_ITEM(moved);
};

const deleteItem = async (owner, id) => {
  const item = await TodoItem.findOne({ _id: id, owner }).select("list").lean();
  await removeOwned(TodoItem, { id, owner });
  notifyDevices(owner, { kind: "item", id, list: item?.list, deleted: true });
};

module.exports = {
  listLists,
  createList,
  updateList,
  moveList,
  deleteList,
  listItems,
  dueItems,
  createItem,
  updateItem,
  moveItem,
  deleteItem,
  MAX_LISTS,
  MAX_ITEMS_PER_LIST
};
