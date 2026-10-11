const ApiError = require("../../utils/ApiError");

/**
 * Owner-only, version-checked writes shared by every planner item.
 *
 * Every filter includes `owner`, so another person's id simply isn't found (404,
 * never 403: it doesn't reveal that the item exists). Updates carry the version
 * the client last saw; a mismatch means another device changed it first, and the
 * 409 brings the current copy so the app can let the person choose.
 */
const updateVersioned = async (Model, { id, owner, version, set }) => {
  const doc = await Model.findOneAndUpdate({ _id: id, owner, version }, { $set: set, $inc: { version: 1 } }, { new: true, runValidators: true }).lean();
  if (doc) return doc;
  const current = await Model.findOne({ _id: id, owner }).lean();
  if (!current) throw new ApiError(404, "Not found");
  throw new ApiError(409, "This was changed on another device. Here is the latest version.", [{ code: "STALE_VERSION", current }]);
};

const removeOwned = async (Model, { id, owner }) => {
  const res = await Model.deleteOne({ _id: id, owner });
  if (!res.deletedCount) throw new ApiError(404, "Not found");
};

/** Refuses a new item past the person's limit (protects the database). */
const assertBelowLimit = async (Model, filter, limit, what) => {
  if ((await Model.countDocuments(filter)) >= limit) {
    throw new ApiError(400, `You've reached the limit of ${limit} ${what}. Delete some first.`, [{ code: "LIMIT_REACHED" }]);
  }
};

/**
 * Cursor page over (updatedAt desc, _id desc): O(page) with the index, stable while
 * items change, unlike skip/limit which slows down and repeats items.
 */
const cursorPage = async (Model, filter, { cursor, limit = 100 }) => {
  const q = { ...filter };
  if (cursor) {
    const [ts, id] = String(cursor).split("_");
    const at = new Date(Number(ts));
    q.$or = [{ updatedAt: { $lt: at } }, { updatedAt: at, _id: { $lt: id } }];
  }
  const rows = await Model.find(q).sort({ updatedAt: -1, _id: -1 }).limit(limit + 1).lean();
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: more && last ? `${new Date(last.updatedAt).getTime()}_${last._id}` : null };
};

/** Tells the person's other devices that something changed (they refetch just that). */
const notifyDevices = (owner, payload) => {
  try {
    const io = require("../../sockets").getIO();
    if (io) io.to(`user:${owner}`).emit("planner:changed", payload);
  } catch {
    /* live updates are best-effort */
  }
};

module.exports = { updateVersioned, removeOwned, assertBelowLimit, cursorPage, notifyDevices };
