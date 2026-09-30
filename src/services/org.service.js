const mongoose = require("mongoose");
const Department = require("../models/Department");
const Designation = require("../models/Designation");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { orgKey } = require("../utils/orgKey");
const { ROLES, STAFF_ROLES } = require("../config/roles");
const { DEPARTMENTS, DESIGNATIONS } = require("../config/orgSeed");

/**
 * Departments and designations (managed lists), plus the rules for assigning them.
 *
 * Both lists are small and read on almost every user screen, so they live in an
 * in-memory snapshot of Maps (by id and by normalised name): every lookup and
 * validation is O(1) with no database round trip. Any write clears the snapshot;
 * a 30 s TTL covers changes made by another server.
 */

const TTL_MS = 30 * 1000;
const SUPERADMIN_ONLY_LEVEL = 2; // levels 1–2 (board, CXO) are assigned by a superadmin only
const MAX_CHAIN = 50; // reports-to walk limit (guards against bad data)

let snap = null;
let snapAt = 0;
let loading = null; // single flight: concurrent requests share one load
let seeded = false;

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const sid = (v) => (v ? String(v) : null);

// ── Seed (first run only) ─────────────────────────────────────────────────────

const ensureSeeded = async () => {
  if (seeded) return;
  const [d, g] = await Promise.all([Department.estimatedDocumentCount(), Designation.estimatedDocumentCount()]);
  if (d === 0 && g === 0) {
    // ordered:false + unique keys make a race between two servers harmless
    await Department.insertMany(
      DEPARTMENTS.map((name, i) => ({ name, key: orgKey(name), sortOrder: i })),
      { ordered: false }
    ).catch((err) => err.code !== 11000 && Promise.reject(err));
    const deptIdByName = new Map((await Department.find().select("name").lean()).map((x) => [x.name, x._id]));
    await Designation.insertMany(
      DESIGNATIONS.map(([name, short, level, suggestedRole, depts], i) => ({
        name,
        key: orgKey(name),
        short,
        level,
        suggestedRole,
        departments: depts.map((n) => deptIdByName.get(n)).filter(Boolean),
        sortOrder: i
      })),
      { ordered: false }
    ).catch((err) => err.code !== 11000 && Promise.reject(err));
    logger.info(`[Org] Seeded ${DEPARTMENTS.length} departments and ${DESIGNATIONS.length} designations`);
  }
  seeded = true;
};

// ── Snapshot ──────────────────────────────────────────────────────────────────

const build = (departments, designations) => {
  const deptById = new Map(departments.map((d) => [sid(d._id), d]));
  const desigById = new Map(
    designations.map((g) => [sid(g._id), { ...g, deptSet: new Set((g.departments || []).map(sid)) }])
  );
  return {
    departments,
    designations: [...desigById.values()],
    deptById,
    desigById,
    deptByKey: new Map(departments.map((d) => [d.key, d])),
    desigByKey: new Map(designations.map((g) => [g.key, g]))
  };
};

const load = async () => {
  if (snap && Date.now() - snapAt < TTL_MS) return snap;
  if (!loading) {
    loading = (async () => {
      await ensureSeeded();
      const [departments, designations] = await Promise.all([
        Department.find().sort({ sortOrder: 1, name: 1 }).lean(),
        Designation.find().sort({ level: 1, sortOrder: 1, name: 1 }).lean()
      ]);
      snap = build(departments, designations);
      snapAt = Date.now();
      return snap;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
};

const invalidate = () => {
  snap = null;
};

// ── Read ──────────────────────────────────────────────────────────────────────

const publicDept = (d, counts, heads) => ({
  _id: d._id,
  name: d.name,
  description: d.description,
  isActive: d.isActive,
  sortOrder: d.sortOrder,
  head: d.head ? heads?.get(sid(d.head)) || { _id: d.head } : null,
  ...(counts && { userCount: counts.get(sid(d._id)) || 0 })
});

const publicDesig = (g, counts) => ({
  _id: g._id,
  name: g.name,
  short: g.short,
  level: g.level,
  departments: g.departments || [],
  suggestedRole: g.suggestedRole,
  isActive: g.isActive,
  sortOrder: g.sortOrder,
  ...(counts && { userCount: counts.get(sid(g._id)) || 0 })
});

// One grouped query for every row's user count (not one count per row)
const countUsersBy = async (field) => {
  const rows = await User.aggregate([{ $match: { [field]: { $ne: null } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [sid(r._id), r.n]));
};

const listDepartments = async ({ includeInactive = false, withCounts = false } = {}) => {
  const s = await load();
  const rows = includeInactive ? s.departments : s.departments.filter((d) => d.isActive);
  const [counts, heads] = await Promise.all([
    withCounts ? countUsersBy("departmentId") : null,
    (async () => {
      const ids = rows.map((d) => d.head).filter(Boolean);
      if (!ids.length) return new Map();
      const users = await User.find({ _id: { $in: ids } }).select("name avatarUrl designation").lean();
      return new Map(users.map((u) => [sid(u._id), u]));
    })()
  ]);
  return rows.map((d) => publicDept(d, counts, heads));
};

const listDesignations = async ({ includeInactive = false, withCounts = false } = {}) => {
  const s = await load();
  const rows = includeInactive ? s.designations : s.designations.filter((g) => g.isActive);
  const counts = withCounts ? await countUsersBy("designationId") : null;
  return rows.map((g) => publicDesig(g, counts));
};

// ── Write (superadmin only — enforced by the routes) ──────────────────────────

const models = { department: Department, designation: Designation };
const userField = { department: ["departmentId", "department"], designation: ["designationId", "designation"] };
const byKey = (s, kind) => (kind === "department" ? s.deptByKey : s.desigByKey);
const byId = (s, kind) => (kind === "department" ? s.deptById : s.desigById);
const label = (kind) => (kind === "department" ? "Department" : "Designation");

const assertNameFree = async (kind, name, exceptId = null) => {
  const s = await load();
  const hit = byKey(s, kind).get(orgKey(name));
  if (hit && sid(hit._id) !== sid(exceptId)) {
    throw new ApiError(409, `${label(kind)} "${hit.name}" already exists${hit.isActive ? "" : " (inactive — reactivate it instead)"}`, [{ code: "ORG_NAME_TAKEN", existingId: String(hit._id) }]);
  }
  if (!orgKey(name)) throw new ApiError(400, "Name must contain letters or numbers");
};

const assertStaffUser = async (userId, what) => {
  const u = await User.findOne({ _id: userId, role: { $in: STAFF_ROLES }, status: "active" }).select("_id").lean();
  if (!u) throw new ApiError(400, `${what} must be an active staff member`);
};

const saveNew = async (kind, doc) => {
  try {
    const created = await models[kind].create(doc);
    return created.toObject();
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, `${label(kind)} "${doc.name}" already exists`, [{ code: "ORG_NAME_TAKEN" }]);
    throw err;
  } finally {
    invalidate();
  }
};

const validDeptIds = async (ids = []) => {
  const s = await load();
  const unique = [...new Set(ids.map(String))];
  for (const id of unique) if (!s.deptById.has(id)) throw new ApiError(400, "Unknown department in the list");
  return unique.map(oid);
};

const createDepartment = async (actor, { name, description = "", head = null }) => {
  await assertNameFree("department", name);
  if (head) await assertStaffUser(head, "Department head");
  const s = await load();
  const sortOrder = s.departments.length ? Math.max(...s.departments.map((d) => d.sortOrder || 0)) + 1 : 0;
  return saveNew("department", { name, key: orgKey(name), description, head, sortOrder, createdBy: actor._id, updatedBy: actor._id });
};

const createDesignation = async (actor, { name, short = "", level, departments = [], suggestedRole = null }) => {
  await assertNameFree("designation", name);
  const deptIds = await validDeptIds(departments);
  const s = await load();
  const sortOrder = s.designations.length ? Math.max(...s.designations.map((g) => g.sortOrder || 0)) + 1 : 0;
  return saveNew("designation", { name, key: orgKey(name), short, level, departments: deptIds, suggestedRole, sortOrder, createdBy: actor._id, updatedBy: actor._id });
};

/** Returns { before, after, usersRenamed } for the audit log. */
const updateItem = async (kind, actor, id, patch) => {
  const s = await load();
  const before = byId(s, kind).get(String(id));
  if (!before) throw new ApiError(404, `${label(kind)} not found`);

  const set = { updatedBy: actor._id };
  if (patch.name !== undefined && patch.name !== before.name) {
    await assertNameFree(kind, patch.name, id);
    set.name = patch.name;
    set.key = orgKey(patch.name);
  }
  for (const f of ["description", "isActive", "short", "level", "suggestedRole"]) if (patch[f] !== undefined) set[f] = patch[f];
  if (patch.head !== undefined) {
    if (patch.head) await assertStaffUser(patch.head, "Department head");
    set.head = patch.head || null;
  }
  if (patch.departments !== undefined) set.departments = await validDeptIds(patch.departments);

  let after;
  try {
    after = await models[kind].findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, `${label(kind)} "${patch.name}" already exists`, [{ code: "ORG_NAME_TAKEN" }]);
    throw err;
  } finally {
    invalidate();
  }

  // Everyone holding it gets the new name in one bulk update (their copy is for fast reads)
  let usersRenamed = 0;
  if (set.name) {
    const [idField, nameField] = userField[kind];
    const r = await User.updateMany({ [idField]: oid(id) }, { $set: { [nameField]: set.name } });
    usersRenamed = r.modifiedCount;
  }
  return { before, after, usersRenamed };
};

/** Delete only when nobody uses it; otherwise deactivate or merge instead. */
const deleteItem = async (kind, id) => {
  const s = await load();
  const item = byId(s, kind).get(String(id));
  if (!item) throw new ApiError(404, `${label(kind)} not found`);
  const [idField] = userField[kind];
  const [users, designations] = await Promise.all([
    User.countDocuments({ [idField]: oid(id) }),
    kind === "department" ? Designation.countDocuments({ departments: oid(id) }) : 0
  ]);
  if (users || designations) {
    throw new ApiError(
      409,
      `${users ? `${users} ${users === 1 ? "person has" : "people have"} this ${kind}` : `${designations} designation(s) use this department`}. Deactivate or merge it instead.`,
      [{ code: "ORG_IN_USE" }]
    );
  }
  await models[kind].deleteOne({ _id: id });
  invalidate();
  return item;
};

/** Moves everyone (and designation links) from one item to another, then deletes the source. */
const mergeItem = async (kind, actor, fromId, intoId) => {
  if (String(fromId) === String(intoId)) throw new ApiError(400, "Choose a different item to merge into");
  const s = await load();
  const from = byId(s, kind).get(String(fromId));
  const into = byId(s, kind).get(String(intoId));
  if (!from || !into) throw new ApiError(404, `${label(kind)} not found`);

  const [idField, nameField] = userField[kind];
  const moved = await User.updateMany({ [idField]: oid(fromId) }, { $set: { [idField]: oid(intoId), [nameField]: into.name } });
  if (kind === "department") {
    // Designations linked to the old department now link to the new one
    await Designation.updateMany({ departments: oid(fromId) }, { $addToSet: { departments: oid(intoId) } });
    await Designation.updateMany({ departments: oid(fromId) }, { $pull: { departments: oid(fromId) } });
  }
  await models[kind].deleteOne({ _id: fromId });
  invalidate();
  return { from, into, usersMoved: moved.modifiedCount };
};

/** Sets the display order from a full list of ids (one bulk write). */
const reorder = async (kind, ids) => {
  const s = await load();
  const all = kind === "department" ? s.departments : s.designations;
  const unique = new Set(ids.map(String));
  if (unique.size !== ids.length || ids.some((id) => !byId(s, kind).has(String(id)))) throw new ApiError(400, "The order must list each item once");
  if (unique.size !== all.length) throw new ApiError(400, "The order must include every item");
  await models[kind].bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: oid(id) }, update: { $set: { sortOrder: i } } } })));
  invalidate();
};

// ── Assignment rules (used by user create / update) ───────────────────────────

/** Most senior level this actor may assign (superadmin: all; admin: below own, never 1–2). */
const minAssignableLevel = async (actor) => {
  if (actor.role === ROLES.SUPERADMIN) return 1;
  const s = await load();
  const own = actor.designationId ? s.desigById.get(sid(actor.designationId))?.level : null;
  return Math.max(SUPERADMIN_ONLY_LEVEL + 1, (own ?? SUPERADMIN_ONLY_LEVEL + 1) + 1);
};

/**
 * Walks up the reports-to chain from `managerId` in memory (one query loads every
 * link into a Map), O(depth). True if `targetId` is on it, i.e. a cycle.
 */
const wouldCycle = async (targetId, managerId) => {
  const links = await User.find({ reportsTo: { $ne: null }, role: { $in: STAFF_ROLES } }).select("reportsTo").lean();
  const up = new Map(links.map((u) => [sid(u._id), sid(u.reportsTo)]));
  return chainReaches(up, managerId, targetId);
};

/**
 * Validates department / designation / reports-to changes and returns the $set patch.
 * `undefined` = leave as is, `null` = clear. `target` is null when creating a user.
 */
const resolveAssignment = async ({ actor, target, targetRole, departmentId, designationId, reportsTo }) => {
  const set = {};
  const touched = departmentId !== undefined || designationId !== undefined || reportsTo !== undefined;
  if (!touched) return set;
  if (targetRole === ROLES.CUSTOMER) {
    if (departmentId || designationId || reportsTo) throw new ApiError(400, "Customers don't have a department, designation or manager");
    return set;
  }
  const s = await load();

  if (departmentId !== undefined) {
    if (departmentId === null) Object.assign(set, { departmentId: null, department: "" });
    else {
      const d = s.deptById.get(String(departmentId));
      if (!d) throw new ApiError(400, "Unknown department");
      if (!d.isActive && sid(target?.departmentId) !== sid(d._id)) throw new ApiError(400, `"${d.name}" is no longer in use`);
      Object.assign(set, { departmentId: d._id, department: d.name });
    }
  }

  if (designationId !== undefined) {
    const minLevel = await minAssignableLevel(actor);
    const current = target?.designationId ? s.desigById.get(sid(target.designationId)) : null;
    // An admin can't change the title of someone more senior than they may assign
    if (current && current.level < minLevel && sid(current._id) !== sid(designationId)) {
      throw new ApiError(403, `Only a superadmin can change the designation of a ${current.name}`, [{ code: "DESIGNATION_TOO_SENIOR" }]);
    }
    if (designationId === null) Object.assign(set, { designationId: null, designation: "" });
    else {
      const g = s.desigById.get(String(designationId));
      if (!g) throw new ApiError(400, "Unknown designation");
      if (!g.isActive && sid(target?.designationId) !== sid(g._id)) throw new ApiError(400, `"${g.name}" is no longer in use`);
      if (g.level < minLevel && sid(target?.designationId) !== sid(g._id)) {
        throw new ApiError(403, `Only a superadmin can assign ${g.name}`, [{ code: "DESIGNATION_TOO_SENIOR" }]);
      }
      Object.assign(set, { designationId: g._id, designation: g.name });
    }
  }

  // The title must belong to the department (when the title is limited to some)
  const deptAfter = "departmentId" in set ? sid(set.departmentId) : sid(target?.departmentId);
  const desigAfter = "designationId" in set ? sid(set.designationId) : sid(target?.designationId);
  if (deptAfter && desigAfter) {
    const g = s.desigById.get(desigAfter);
    if (g && g.deptSet.size && !g.deptSet.has(deptAfter)) {
      throw new ApiError(400, `${g.name} isn't a designation in ${s.deptById.get(deptAfter)?.name || "that department"}`, [{ code: "DESIGNATION_DEPARTMENT_MISMATCH" }]);
    }
  }

  if (reportsTo !== undefined) {
    if (reportsTo === null) set.reportsTo = null;
    else {
      if (target && sid(reportsTo) === sid(target._id)) throw new ApiError(400, "Someone can't report to themselves");
      await assertStaffUser(reportsTo, "The manager");
      if (target && (await wouldCycle(target._id, reportsTo))) {
        throw new ApiError(400, "That would create a loop: this person is above the chosen manager", [{ code: "REPORTS_TO_CYCLE" }]);
      }
      set.reportsTo = oid(reportsTo);
    }
  }
  return set;
};

// ── Hierarchy (org chart, my team) ────────────────────────────────────────────
// Pure graph helpers (unit-tested without a database) ────────────────────────

const bySeniority = (a, b) => a.level - b.level || a.name.localeCompare(b.name);

/** People → Map id → node with sorted direct reports. One pass to index, one to link: O(n log n) with sorting. */
const graphFrom = (people, levelOf = () => 99) => {
  const nodes = new Map(
    people.map((u) => [
      sid(u._id),
      {
        _id: u._id,
        name: u.name,
        avatarUrl: u.avatarUrl,
        role: u.role,
        department: u.department,
        designation: u.designation,
        level: levelOf(u) ?? 99,
        reportsTo: sid(u.reportsTo),
        reports: []
      }
    ])
  );
  for (const n of nodes.values()) {
    const manager = n.reportsTo && nodes.get(n.reportsTo);
    if (manager && manager !== n) manager.reports.push(n);
  }
  for (const n of nodes.values()) n.reports.sort(bySeniority);
  return nodes;
};

/** Top-level people (no manager, or manager not in the list), plus anyone stuck in a loop. */
const rootsOf = (nodes) => {
  const roots = [...nodes.values()].filter((n) => !n.reportsTo || !nodes.has(n.reportsTo));
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...n.reports);
  }
  // Unreachable from the top = part of a reporting loop (bad data): surface one per loop
  for (const n of nodes.values()) {
    if (seen.has(n)) continue;
    roots.push(n);
    const loop = [n];
    while (loop.length) {
      const m = loop.pop();
      if (seen.has(m)) continue;
      seen.add(m);
      loop.push(...m.reports);
    }
  }
  return roots.sort(bySeniority);
};

/** Everyone under `rootId`, breadth-first with depth. O(team size). */
const teamOf = (nodes, rootId) => {
  const me = nodes.get(sid(rootId));
  if (!me) return { direct: [], all: [] };
  const all = [];
  const seen = new Set([me]);
  let frontier = me.reports.map((n) => [n, 1]);
  while (frontier.length) {
    const next = [];
    for (const [n, depth] of frontier) {
      if (seen.has(n)) continue;
      seen.add(n);
      const { reports, ...rest } = n;
      all.push({ ...rest, depth, reportCount: reports.length });
      for (const c of reports) next.push([c, depth + 1]);
    }
    frontier = next;
  }
  return { direct: all.filter((n) => n.depth === 1), all };
};

/** Walks up from `managerId` through `up` (Map id → manager id). True if it reaches `targetId`. O(depth). */
const chainReaches = (up, managerId, targetId) => {
  let cur = sid(managerId);
  for (let hops = 0; cur && hops < MAX_CHAIN; hops += 1) {
    if (cur === sid(targetId)) return true;
    cur = up.get(cur) || null;
  }
  return false;
};

const CHART_FIELDS = "name avatarUrl role department designation departmentId designationId reportsTo";

const loadGraph = async () => {
  const [s, staff] = await Promise.all([
    load(),
    User.find({ role: { $in: STAFF_ROLES }, status: "active" }).select(CHART_FIELDS).lean()
  ]);
  return graphFrom(staff, (u) => s.desigById.get(sid(u.designationId))?.level);
};

/** Whole organisation as a tree (people with no manager at the top). */
const getChart = async () => {
  const nodes = await loadGraph();
  return { roots: rootsOf(nodes), total: nodes.size };
};

/** Everyone under this person. */
const getTeam = async (userId) => teamOf(await loadGraph(), userId);

module.exports = {
  load,
  invalidate,
  listDepartments,
  listDesignations,
  createDepartment,
  createDesignation,
  updateItem,
  deleteItem,
  mergeItem,
  reorder,
  resolveAssignment,
  minAssignableLevel,
  getChart,
  getTeam,
  _internals: { graphFrom, rootsOf, teamOf, chainReaches, build }
};
