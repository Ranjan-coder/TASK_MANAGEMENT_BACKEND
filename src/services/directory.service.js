const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const modules = require("../config/modules");
const { ROLES, STAFF_ROLES } = require("../config/roles");
const { effectiveUserMask } = require("./moduleAccess.service");

/**
 * The staff directory: "who in my organisation can I pick?" for chat, the Planner
 * and any other people picker. One place, so every picker gets the same rules:
 *
 * - Only this organisation (the tenant plugin scopes every query).
 * - Only active staff. Customers are outside the organisation's team and never
 *   appear here; screens that pick customers search them separately.
 * - Optionally only people who hold a module (e.g. chat): filtered by the database,
 *   so a page is always full and nobody is silently dropped.
 * - Only what a picker shows: no email, phone or other personal details.
 *
 * Scale: the index { orgId, status, role, name, _id } answers the filter and the
 * name order together (one sorted index scan per staff role, merged by MongoDB),
 * and pages use a keyset cursor (name, _id) instead of skip, so page N costs the
 * same as page 1 however large the organisation is.
 */

const PAGE = 20;
const MAX_PAGE = 50;
const FIELDS = "name avatarUrl designation role publicKey keyVersion moduleAccess";

const escapeRegex = (s) => String(s).slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The database-side twin of moduleAccess.userModuleMask for one module: who holds
 * it. Everyone holds core, on-by-default and organisation-wide modules.
 */
const holdersQuery = (key) => {
  if (!key || modules.isCore(key) || modules.isDefaultOn(key) || modules.isOrgWide(key)) return null;
  return {
    $or: [
      { role: ROLES.SUPERADMIN },
      { "moduleAccess.all": true },
      { role: ROLES.ADMIN, "moduleAccess.all": null }, // admins hold everything unless narrowed (M4)
      { "moduleAccess.keys": key }
    ]
  };
};

// Keyset cursor: the last row's (name, _id), opaque to the client
const encodeCursor = (u) => Buffer.from(JSON.stringify([u.name, String(u._id)])).toString("base64url");
const decodeCursor = (c) => {
  try {
    const [name, id] = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8"));
    return typeof name === "string" && /^[a-f0-9]{24}$/i.test(id) ? { name, id } : null;
  } catch {
    return null;
  }
};

/**
 * One page of staff, in name order.
 * @param {object} o
 * @param {string} [o.q]         matches the start of any word of the name ("ra" finds "Ravi" and "Anil Rao")
 * @param {string} [o.module]    only people who can use this module
 * @param {number} [o.orgMask]   the organisation's modules (req.orgModules); required with `module`
 * @param {*}      [o.excludeId] leave this person out (usually the one searching)
 * @param {string} [o.cursor]    from the previous page's `next`
 * @param {number} [o.limit]
 * @returns {Promise<{ people: object[], next: string|null }>}
 */
const searchStaff = async ({ q = "", module: key, orgMask = 0, excludeId, cursor, limit = PAGE } = {}) => {
  // The organisation doesn't have the module: nobody can be picked for it
  if (key && !(orgMask & modules.BIT[key])) return { people: [], next: null };

  const size = Math.min(Math.max(Number(limit) || PAGE, 1), MAX_PAGE);
  const and = [{ status: "active", role: { $in: STAFF_ROLES }, deletedAt: null }];
  const text = String(q || "").trim();
  if (text) and.push({ name: { $regex: `(?:^|\\s)${escapeRegex(text)}`, $options: "i" } });
  if (excludeId) and.push({ _id: { $ne: excludeId } });
  const holders = holdersQuery(key);
  if (holders) and.push(holders);
  const after = cursor ? decodeCursor(cursor) : null;
  if (after) and.push({ $or: [{ name: { $gt: after.name } }, { name: after.name, _id: { $gt: after.id } }] });

  // One extra row tells whether there is a next page
  const rows = await User.find({ $and: and }).select(FIELDS).sort({ name: 1, _id: 1 }).limit(size + 1).lean();
  const page = rows.slice(0, size);
  // Final check with the exact rule (also covers modules whose requirements are off)
  const usable = key ? page.filter((u) => effectiveUserMask(u, orgMask) & modules.BIT[key]) : page;
  return {
    people: usable.map((u) => ({
      _id: u._id,
      name: u.name,
      avatarUrl: u.avatarUrl || "",
      designation: u.designation || "",
      role: u.role,
      // Public keys are public by design: pickers need them to start an encrypted chat
      publicKey: u.publicKey || null,
      keyVersion: u.keyVersion || 0
    })),
    next: rows.length > size ? encodeCursor(page[page.length - 1]) : null
  };
};

/**
 * Refuses a list of people unless every one is an active staff member of this
 * organisation (e.g. task assignees and watchers). One indexed count for the
 * whole list (a Set removes duplicates first). Other organisations' ids are never
 * found because the query is organisation-scoped, so they are refused too.
 */
const assertStaff = async (ids, what = "people") => {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const unique = [...new Set(ids.map(String))];
  if (unique.some((id) => !/^[a-f0-9]{24}$/i.test(id))) throw new ApiError(400, `Invalid ${what}`);
  const found = await User.countDocuments({ _id: { $in: unique }, role: { $in: STAFF_ROLES }, status: "active", deletedAt: null });
  if (found !== unique.length) {
    throw new ApiError(400, `Only active staff of your organisation can be ${what}.`, [{ code: "NOT_STAFF" }]);
  }
};

module.exports = { searchStaff, assertStaff, holdersQuery, escapeRegex, PAGE, MAX_PAGE };
