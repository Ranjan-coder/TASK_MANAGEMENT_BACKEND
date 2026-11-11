const mongoose = require("mongoose");
const Department = require("../models/Department");
const Designation = require("../models/Designation");
const User = require("../models/User");
const { TemplateDepartment, TemplateDesignation, SYNCED } = require("../models/OrgTemplate");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const tenant = require("../utils/tenantContext");
const { orgKey } = require("../utils/orgKey");
const { DEPARTMENTS, DESIGNATIONS } = require("../config/orgSeed");

/**
 * The standard departments and designations (product owner) and how they reach
 * organisations.
 *
 * Each organisation keeps its own copies, linked by `templateId`, so its people,
 * counts and edits stay inside it. A product-owner change is carried to every copy
 * EXCEPT the fields that organisation changed itself (`overrides`; the
 * organisation's edit wins). A new standard item is added to every organisation.
 *
 * Cost of one product-owner change (n = organisations):
 *   - plain fields (level, active …): one updateMany per changed field, on the
 *     { templateId } index, for all organisations at once
 *   - a rename: one read + one bulkWrite (unordered, chunked) + one user-copy update
 *   - departments of a designation: two reads + one bulkWrite, mapping standard
 *     department ids to each organisation's own ids through a Map
 *   - a new item: two reads + one bulkWrite
 * Never one round trip per organisation.
 */

const CHUNK = 1000;
const models = {
  department: { tpl: TemplateDepartment, org: Department, userId: "departmentId", userName: "department" },
  designation: { tpl: TemplateDesignation, org: Designation, userId: "designationId", userName: "designation" }
};
const label = (kind) => (kind === "department" ? "Department" : "Designation");
const sid = (v) => (v ? String(v) : null);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const sys = (fn) => tenant.runAsSystem(fn);

const chunks = (arr, n = CHUNK) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Unordered bulk write in chunks; returns the set of op indexes that failed (e.g. a name clash). */
const bulk = async (Model, ops) => {
  const failed = new Set();
  let base = 0;
  for (const part of chunks(ops)) {
    try {
      if (part.length) await sys(() => Model.bulkWrite(part, { ordered: false }));
    } catch (err) {
      const errors = [].concat(err.writeErrors || err.result?.getWriteErrors?.() || []);
      if (!errors.length) throw err;
      for (const e of errors) failed.add(base + (e.index ?? e.err?.index));
    }
    base += part.length;
  }
  return failed;
};

const clearOrgCaches = () => require("./org.service").clearAll();

// ── Bootstrap: the standard list exists, and organisations' items are linked ──

let ready = null;

/**
 * First use: the standard list is created from config/orgSeed.js, then every
 * organisation's matching items (same normalised name) are linked to it, keeping
 * whatever each organisation already changed. Single flight per process.
 */
const ensureTemplate = () => {
  if (!ready) {
    ready = (async () => {
      const [d, g] = await Promise.all([TemplateDepartment.countDocuments(), TemplateDesignation.countDocuments()]);
      if (d === 0 && g === 0) {
        const ignoreDup = (err) => err.code !== 11000 && !err.writeErrors && Promise.reject(err);
        await TemplateDepartment.insertMany(
          DEPARTMENTS.map((name, i) => ({ name, key: orgKey(name), sortOrder: i })),
          { ordered: false }
        ).catch(ignoreDup);
        const deptByName = new Map((await TemplateDepartment.find().select("name").lean()).map((x) => [x.name, x._id]));
        await TemplateDesignation.insertMany(
          DESIGNATIONS.map(([name, short, level, suggestedRole, depts], i) => ({
            name,
            key: orgKey(name),
            short,
            level,
            suggestedRole,
            departments: depts.map((n) => deptByName.get(n)).filter(Boolean),
            sortOrder: i
          })),
          { ordered: false }
        ).catch(ignoreDup);
        const linked = await linkExisting();
        logger.info(`[OrgTemplate] Standard list created; linked ${linked.departments} departments and ${linked.designations} designations in existing organisations`);
      }
    })().catch((err) => {
      ready = null; // try again next time
      throw err;
    });
  }
  return ready;
};

/** Which synced fields of an organisation's copy differ from the standard item. */
const diffFields = (kind, orgItem, tpl, tplDeptIdsOf) => {
  const out = [];
  for (const f of SYNCED[kind]) {
    if (f === "departments") {
      const mine = tplDeptIdsOf(orgItem); // the organisation's departments, as standard ids (null if one is its own)
      const theirs = new Set((tpl.departments || []).map(sid));
      if (!mine || mine.size !== theirs.size || [...mine].some((x) => !theirs.has(x))) out.push(f);
    } else if ((orgItem[f] ?? null) !== (tpl[f] ?? null) && !(f === "description" && !orgItem[f] && !tpl[f])) {
      out.push(f);
    }
  }
  return out;
};

/** Map<orgDepartmentId, standardDepartmentId> for linked departments (one read). */
const orgDeptToTemplate = async (filter = {}) => {
  const rows = await sys(() => Department.find({ ...filter, templateId: { $type: "objectId" } }).select("templateId orgId").lean());
  return new Map(rows.map((r) => [sid(r._id), sid(r.templateId)]));
};

const tplDeptIdsVia = (deptMap) => (orgItem) => {
  const ids = new Set();
  for (const d of orgItem.departments || []) {
    const t = deptMap.get(sid(d));
    if (!t) return null; // linked to one of the organisation's own departments
    ids.add(t);
  }
  return ids;
};

/** Links unlinked organisation items to standard items with the same normalised name. */
const linkExisting = async () => {
  const counts = { departments: 0, designations: 0 };
  for (const kind of ["department", "designation"]) {
    const { tpl, org } = models[kind];
    const templates = await tpl.find().lean();
    const byKey = new Map(templates.map((t) => [t.key, t]));
    const items = await sys(() => org.find({ templateId: null, key: { $in: [...byKey.keys()] } }).lean());
    const deptMap = kind === "designation" ? await orgDeptToTemplate() : null;
    const ops = items.map((it) => {
      const t = byKey.get(it.key);
      return {
        updateOne: {
          filter: { _id: it._id, templateId: null },
          update: { $set: { templateId: t._id, overrides: diffFields(kind, it, t, deptMap ? tplDeptIdsVia(deptMap) : () => new Set()) } }
        }
      };
    });
    await bulk(org, ops);
    counts[`${kind}s`] = ops.length;
  }
  clearOrgCaches();
  return counts;
};

// ── A new organisation starts from the standard list ─────────────────────────

/** Copies the active standard items into the current organisation (linked). */
const seedCurrentOrg = async () => {
  await ensureTemplate();
  const [depts, desigs] = await Promise.all([
    TemplateDepartment.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    TemplateDesignation.find({ isActive: true }).sort({ level: 1, sortOrder: 1, name: 1 }).lean()
  ]);
  const ignoreDup = (err) => err.code !== 11000 && !err.writeErrors && Promise.reject(err);
  await Department.insertMany(
    depts.map((t, i) => ({ name: t.name, key: t.key, description: t.description, sortOrder: i, templateId: t._id })),
    { ordered: false }
  ).catch(ignoreDup);
  const mine = new Map((await Department.find({ templateId: { $type: "objectId" } }).select("templateId").lean()).map((d) => [sid(d.templateId), d._id]));
  await Designation.insertMany(
    desigs.map((t, i) => ({
      name: t.name,
      key: t.key,
      short: t.short,
      level: t.level,
      suggestedRole: t.suggestedRole,
      departments: (t.departments || []).map((d) => mine.get(sid(d))).filter(Boolean),
      sortOrder: i,
      templateId: t._id
    })),
    { ordered: false }
  ).catch(ignoreDup);
  return { departments: depts.length, designations: desigs.length };
};

// ── Product owner: read ───────────────────────────────────────────────────────

/** How many organisations have a copy of each standard item, and how many changed it. */
const usage = async (Model) => {
  const rows = await sys(() =>
    Model.aggregate([
      { $match: { templateId: { $type: "objectId" } } },
      { $group: { _id: "$templateId", companies: { $sum: 1 }, customised: { $sum: { $cond: [{ $gt: [{ $size: "$overrides" }, 0] }, 1, 0] } } } }
    ])
  );
  return new Map(rows.map((r) => [sid(r._id), { companies: r.companies, customised: r.customised }]));
};

const publicTemplate = (kind, t, use) => ({
  _id: t._id,
  name: t.name,
  isActive: t.isActive,
  sortOrder: t.sortOrder,
  ...(kind === "department"
    ? { description: t.description || "" }
    : { short: t.short, level: t.level, departments: (t.departments || []).map(sid), suggestedRole: t.suggestedRole }),
  companies: use.get(sid(t._id))?.companies || 0,
  customised: use.get(sid(t._id))?.customised || 0
});

const listTemplate = async () => {
  await ensureTemplate();
  const [depts, desigs, deptUse, desigUse] = await Promise.all([
    TemplateDepartment.find().sort({ sortOrder: 1, name: 1 }).lean(),
    TemplateDesignation.find().sort({ level: 1, sortOrder: 1, name: 1 }).lean(),
    usage(Department),
    usage(Designation)
  ]);
  return {
    departments: depts.map((t) => publicTemplate("department", t, deptUse)),
    designations: desigs.map((t) => publicTemplate("designation", t, desigUse))
  };
};

// ── Product owner: write, and carry the change to organisations ──────────────

const assertTemplateDepts = async (ids = []) => {
  const unique = [...new Set(ids.map(String))];
  if (unique.some((id) => !/^[a-f0-9]{24}$/i.test(id))) throw new ApiError(400, "Unknown department in the list");
  const found = await TemplateDepartment.countDocuments({ _id: { $in: unique } });
  if (found !== unique.length) throw new ApiError(400, "Unknown department in the list");
  return unique.map(oid);
};

const assertKeyFree = async (kind, name, exceptId = null) => {
  const key = orgKey(name);
  if (!key) throw new ApiError(400, "Name must contain letters or numbers");
  const hit = await models[kind].tpl.findOne({ key }).select("name").lean();
  if (hit && sid(hit._id) !== sid(exceptId)) throw new ApiError(409, `${label(kind)} "${hit.name}" already exists in the standard list`, [{ code: "ORG_NAME_TAKEN" }]);
  return key;
};

/** Organisations whose lists exist (a never-opened organisation is seeded later, from the template). */
const seededOrgIds = async () => (await sys(() => Department.distinct("orgId"))).filter(Boolean).map(sid);

/**
 * A new standard item reaches every organisation. One that already has an item
 * with the same name gets it linked instead (its differences kept as its own).
 */
const pushNew = async (kind, t) => {
  const { org } = models[kind];
  const [orgIds, existing] = await Promise.all([seededOrgIds(), sys(() => org.find({ key: t.key }).lean())]);
  const has = new Map(existing.map((e) => [sid(e.orgId), e]));

  // Designations: the standard departments, as each organisation's own department ids
  let deptOf = () => [];
  let deptMap = new Map();
  if (kind === "designation" && t.departments?.length) {
    const rows = await sys(() => Department.find({ templateId: { $in: t.departments } }).select("orgId templateId").lean());
    const byOrg = new Map();
    for (const r of rows) {
      if (!byOrg.has(sid(r.orgId))) byOrg.set(sid(r.orgId), []);
      byOrg.get(sid(r.orgId)).push(r._id);
    }
    deptOf = (orgId) => byOrg.get(orgId) || [];
    deptMap = new Map(rows.map((r) => [sid(r._id), sid(r.templateId)]));
  }

  const ops = [];
  for (const orgId of orgIds) {
    const same = has.get(orgId);
    if (same) {
      if (!same.templateId) {
        const overrides = diffFields(kind, same, t, tplDeptIdsVia(deptMap));
        ops.push({ updateOne: { filter: { _id: same._id, templateId: null }, update: { $set: { templateId: t._id, overrides } } } });
      }
      continue;
    }
    const doc = { orgId: oid(orgId), name: t.name, key: t.key, isActive: t.isActive, sortOrder: 100000 + (t.sortOrder || 0), templateId: t._id, overrides: [] };
    if (kind === "department") doc.description = t.description || "";
    else Object.assign(doc, { short: t.short, level: t.level, suggestedRole: t.suggestedRole, departments: deptOf(orgId) });
    ops.push({ insertOne: { document: doc } });
  }
  const failed = await bulk(org, ops);
  clearOrgCaches();
  return { companies: ops.length - failed.size };
};

/** Carries changed fields to every copy that hasn't changed that field itself. */
const propagate = async (kind, t, fields) => {
  const { org, userId, userName } = models[kind];
  const touched = new Set();
  const notTouching = (f) => ({ templateId: t._id, overrides: { $ne: f } });

  for (const f of fields) {
    if (f === "name") {
      // A rename can clash with a name the organisation already uses: that one keeps its name
      const rows = await sys(() => org.find(notTouching("name")).select("_id orgId").lean());
      const failed = await bulk(
        org,
        rows.map((r) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { name: t.name, key: t.key } } } }))
      );
      const ok = rows.filter((_, i) => !failed.has(i));
      if (failed.size) await sys(() => org.updateMany({ _id: { $in: rows.filter((_, i) => failed.has(i)).map((r) => r._id) } }, { $addToSet: { overrides: "name" } }));
      // People keep a copy of the name for fast reads: one update for every organisation
      for (const part of chunks(ok.map((r) => r._id))) {
        await sys(() => User.updateMany({ [userId]: { $in: part } }, { $set: { [userName]: t.name } }));
      }
      ok.forEach((r) => touched.add(sid(r.orgId)));
    } else if (f === "departments") {
      const [rows, depts] = await Promise.all([
        sys(() => org.find(notTouching("departments")).select("_id orgId").lean()),
        sys(() => Department.find({ templateId: { $in: t.departments || [] } }).select("orgId").lean())
      ]);
      const byOrg = new Map();
      for (const d of depts) {
        if (!byOrg.has(sid(d.orgId))) byOrg.set(sid(d.orgId), []);
        byOrg.get(sid(d.orgId)).push(d._id);
      }
      await bulk(org, rows.map((r) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { departments: byOrg.get(sid(r.orgId)) || [] } } } })));
      rows.forEach((r) => touched.add(sid(r.orgId)));
    } else {
      const reached = await sys(() => org.distinct("orgId", notTouching(f)));
      await sys(() => org.updateMany(notTouching(f), { $set: { [f]: t[f] ?? null } }));
      reached.forEach((o) => touched.add(sid(o)));
    }
  }
  const kept = fields.length ? await sys(() => org.countDocuments({ templateId: t._id, overrides: { $in: fields } })) : 0;
  clearOrgCaches();
  return { companies: touched.size, kept };
};

const createTemplateItem = async (kind, actor, body) => {
  await ensureTemplate();
  const key = await assertKeyFree(kind, body.name);
  const last = await models[kind].tpl.findOne().sort({ sortOrder: -1 }).select("sortOrder").lean();
  const doc = { name: body.name, key, sortOrder: (last?.sortOrder ?? -1) + 1, updatedBy: actor._id };
  if (kind === "department") doc.description = body.description || "";
  else Object.assign(doc, { short: body.short || "", level: body.level, suggestedRole: body.suggestedRole ?? null, departments: await assertTemplateDepts(body.departments) });
  let t;
  try {
    t = (await models[kind].tpl.create(doc)).toObject();
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, `${label(kind)} "${body.name}" already exists in the standard list`, [{ code: "ORG_NAME_TAKEN" }]);
    throw err;
  }
  const reach = await pushNew(kind, t);
  return { item: t, ...reach };
};

const updateTemplateItem = async (kind, actor, id, patch) => {
  await ensureTemplate();
  const { tpl } = models[kind];
  const before = await tpl.findById(id).lean();
  if (!before) throw new ApiError(404, `${label(kind)} not found in the standard list`);

  const set = { updatedBy: actor._id };
  if (patch.name !== undefined && patch.name !== before.name) {
    set.key = await assertKeyFree(kind, patch.name, id);
    set.name = patch.name;
  }
  for (const f of SYNCED[kind]) {
    if (f === "name" || patch[f] === undefined) continue;
    set[f] = f === "departments" ? await assertTemplateDepts(patch[f]) : patch[f];
  }
  let after;
  try {
    after = await tpl.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, `${label(kind)} "${patch.name}" already exists in the standard list`, [{ code: "ORG_NAME_TAKEN" }]);
    throw err;
  }
  // Only fields that really changed travel to organisations
  const changed = SYNCED[kind].filter((f) =>
    f === "departments"
      ? set.departments !== undefined && JSON.stringify((before.departments || []).map(sid).sort()) !== JSON.stringify((after.departments || []).map(sid).sort())
      : set[f] !== undefined && (before[f] ?? null) !== (after[f] ?? null)
  );
  const reach = await propagate(kind, after, changed);
  return { before, after, changed, ...reach };
};

/**
 * Removes an item from the standard list. Organisations keep their copies (people
 * may hold them) as their own items; to take one out of use everywhere, deactivate
 * it instead (that does reach every organisation that hasn't changed it).
 */
const deleteTemplateItem = async (kind, id) => {
  await ensureTemplate();
  const { tpl, org } = models[kind];
  const t = await tpl.findById(id).lean();
  if (!t) throw new ApiError(404, `${label(kind)} not found in the standard list`);
  await tpl.deleteOne({ _id: id });
  if (kind === "department") await TemplateDesignation.updateMany({ departments: t._id }, { $pull: { departments: t._id } });
  const res = await sys(() => org.updateMany({ templateId: t._id }, { $set: { templateId: null, overrides: [] } }));
  clearOrgCaches();
  return { item: t, detached: res.modifiedCount };
};

// ── Organisation side: "Reset to standard" ───────────────────────────────────

/** The standard values for one organisation item (departments as that organisation's ids). */
const standardValues = async (kind, item) => {
  if (!item.templateId) throw new ApiError(400, "This isn't a standard item");
  const t = await models[kind].tpl.findById(item.templateId).lean();
  if (!t) throw new ApiError(400, "This item is no longer in the standard list");
  const values = {};
  for (const f of SYNCED[kind]) {
    if (f === "departments") {
      const mine = await Department.find({ templateId: { $in: t.departments || [] } }).select("_id").lean(); // current organisation
      values.departments = mine.map((d) => d._id);
    } else values[f] = t[f] ?? (f === "description" || f === "short" ? "" : null);
  }
  values.key = t.key;
  return values;
};

module.exports = {
  ensureTemplate,
  linkExisting,
  seedCurrentOrg,
  listTemplate,
  createTemplateItem,
  updateTemplateItem,
  deleteTemplateItem,
  standardValues,
  _internals: { diffFields, chunks }
};
