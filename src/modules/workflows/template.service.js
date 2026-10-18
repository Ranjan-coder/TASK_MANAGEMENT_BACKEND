const tenant = require("../../utils/tenantContext");
const logger = require("../../utils/logger");
const { WorkflowTemplate, WorkflowTemplateVersion } = require("./models/WorkflowTemplate");
const { normaliseTree } = require("./engine/tree");
const { BASIC } = require("./engine/basic");

/**
 * The product owner's standard workflows (W1, W7). Global documents, always read
 * and written in system context.
 *
 * First use: the Basic workflow (today's 7 stages) is created and marked as the
 * default for new companies. Single flight, and the partial unique index on
 * `defaultForNewCompanies` makes a race between two servers harmless.
 */
let ensured = null;

const ensureStandard = () => {
  if (!ensured) {
    ensured = tenant
      .runAsSystem(async () => {
        if (await WorkflowTemplate.exists({})) return;
        const tree = normaliseTree(BASIC.tree);
        let template;
        try {
          template = await WorkflowTemplate.create({ name: BASIC.name, description: BASIC.description, defaultForNewCompanies: true });
        } catch (err) {
          if (err.code === 11000) return; // another server created it first
          throw err;
        }
        const v = await WorkflowTemplateVersion.create({ templateId: template._id, version: 1, tree });
        await WorkflowTemplate.updateOne({ _id: template._id }, { $set: { currentVersion: 1, currentVersionId: v._id } });
        logger.info("[Workflows] Created the Basic standard workflow");
      })
      .catch((err) => {
        ensured = null; // retry on the next call
        throw err;
      });
  }
  return ensured;
};

/** The standard workflow new companies start with, and its latest version. */
const defaultForNewCompany = async () => {
  await ensureStandard();
  return tenant.runAsSystem(async () => {
    const template = (await WorkflowTemplate.findOne({ defaultForNewCompanies: true, archived: false }).lean()) || (await WorkflowTemplate.findOne({ archived: false }).sort({ createdAt: 1 }).lean());
    if (!template?.currentVersionId) throw new Error("No standard workflow has been published");
    const version = await WorkflowTemplateVersion.findById(template.currentVersionId).lean();
    return { template, version };
  });
};

/** Latest published version of a standard workflow (for "new version available", W7). */
const latestVersion = (templateId) =>
  tenant.runAsSystem(async () => {
    const t = await WorkflowTemplate.findById(templateId).select("currentVersion currentVersionId archived name").lean();
    if (!t || t.archived || !t.currentVersionId) return null;
    const v = await WorkflowTemplateVersion.findById(t.currentVersionId).lean();
    return v ? { template: t, version: v } : null;
  });

// ── Product owner console (W1, W7) ────────────────────────────────────────────

const ApiError = require("../../utils/ApiError");
const { WorkflowError } = require("./engine/tree");
const { diffTrees, summaryJson } = require("./engine/diff");
const { compile } = require("./engine/compile");
const nav = require("./engine/navigate");

const fail = (status, code, message, extra = {}) => new ApiError(status, message, [{ code, ...extra }]);

/** Standards are company-neutral: who handles a stage is each company's own choice. */
const neutral = (raw) => {
  let tree;
  try {
    tree = normaliseTree(raw);
  } catch (err) {
    if (err instanceof WorkflowError) throw fail(400, err.code, err.message, { path: err.path });
    throw err;
  }
  for (const s of tree.stages) {
    s.departmentId = null;
    s.handlers = [];
  }
  return tree;
};

const preview = (tree) => {
  const c = compile(tree);
  return nav.customerView(c, { stepKey: c.firstStepKey, status: "active", activated: new Set(), ticks: {}, extras: [], checks: new Set() });
};

const sys = (fn) => tenant.runAsSystem(fn);

/** Every standard workflow, with how many companies follow each (one grouped query). */
const listTemplates = async () => {
  await ensureStandard();
  return sys(async () => {
    const Workflow = require("./models/Workflow");
    const [list, usage] = await Promise.all([
      WorkflowTemplate.find().sort({ archived: 1, defaultForNewCompanies: -1, name: 1 }).lean(),
      Workflow.aggregate([{ $match: { "basedOn.templateId": { $ne: null } } }, { $group: { _id: "$basedOn.templateId", n: { $sum: 1 } } }])
    ]);
    const used = new Map(usage.map((u) => [String(u._id), u.n]));
    return list.map((t) => ({
      _id: t._id,
      name: t.name,
      description: t.description,
      defaultForNewCompanies: t.defaultForNewCompanies,
      currentVersion: t.currentVersion,
      hasDraft: Boolean(t.draft),
      archived: t.archived,
      companies: used.get(String(t._id)) || 0,
      updatedAt: t.updatedAt
    }));
  });
};

const getTemplate = (id) =>
  sys(async () => {
    const t = await WorkflowTemplate.findById(id).lean();
    if (!t) throw new ApiError(404, "Standard workflow not found");
    const current = t.currentVersionId ? await WorkflowTemplateVersion.findById(t.currentVersionId).lean() : null;
    const versions = await WorkflowTemplateVersion.find({ templateId: t._id }).select("version publishedAt summary").sort({ version: -1 }).limit(50).lean();
    const tree = current?.tree || { stages: [] };
    return { ...t, tree, preview: tree.stages.length ? preview(tree) : null, versions: versions.map((v) => ({ version: v.version, publishedAt: v.publishedAt })) };
  });

/** A new standard workflow: a copy of another one, or of the Basic stages. */
const createTemplate = async (actor, { name, description = "", copyOf = null }) => {
  await ensureStandard();
  return sys(async () => {
    let tree = normaliseTree(BASIC.tree);
    if (copyOf) {
      const src = await WorkflowTemplate.findById(copyOf).select("currentVersionId").lean();
      const v = src?.currentVersionId && (await WorkflowTemplateVersion.findById(src.currentVersionId).select("tree").lean());
      if (!v) throw new ApiError(404, "The workflow to copy wasn't found");
      tree = v.tree;
    }
    // Starts as a draft: nothing reaches companies until it's published
    const t = await WorkflowTemplate.create({ name, description, draft: neutral(tree), updatedBy: actor._id });
    return getTemplate(t._id);
  });
};

const updateTemplate = (actor, id, { name, description, archived }) =>
  sys(async () => {
    const t = await WorkflowTemplate.findById(id).lean();
    if (!t) throw new ApiError(404, "Standard workflow not found");
    if (archived && t.defaultForNewCompanies) throw fail(400, "DEFAULT_CANT_ARCHIVE", "Choose another default for new companies first");
    await WorkflowTemplate.updateOne({ _id: id }, { $set: { ...(name !== undefined && { name }), ...(description !== undefined && { description }), ...(archived !== undefined && { archived }), updatedBy: actor._id } });
    return getTemplate(id);
  });

const saveTemplateDraft = (actor, id, { tree: raw, revision }) =>
  sys(async () => {
    const tree = neutral(raw);
    const t = await WorkflowTemplate.findOneAndUpdate(
      { _id: id, draftRevision: revision },
      { $set: { draft: tree, updatedBy: actor._id }, $inc: { draftRevision: 1 } },
      { new: true }
    ).lean();
    if (!t) throw fail(409, "DRAFT_CHANGED", "Someone else changed this draft. Reload to see it.");
    const current = t.currentVersionId ? await WorkflowTemplateVersion.findById(t.currentVersionId).select("tree").lean() : null;
    return { draft: t.draft, draftRevision: t.draftRevision, summary: summaryJson(diffTrees(current?.tree || { stages: [] }, tree)), preview: preview(tree) };
  });

/**
 * Publishes the draft as version N+1. Companies that started from this workflow
 * are offered it ("New version available"); nothing changes for them until an
 * admin there applies it (W7). New companies get it if it's the default.
 */
const publishTemplate = (actor, id, { revision }) =>
  sys(async () => {
    const t = await WorkflowTemplate.findById(id).lean();
    if (!t) throw new ApiError(404, "Standard workflow not found");
    if (!t.draft) throw fail(400, "NO_DRAFT", "There are no changes to publish");
    if (t.draftRevision !== revision) throw fail(409, "DRAFT_CHANGED", "The draft changed since you looked at it");
    const tree = neutral(t.draft);
    const prev = t.currentVersionId ? await WorkflowTemplateVersion.findById(t.currentVersionId).select("tree").lean() : null;
    const diff = diffTrees(prev?.tree || { stages: [] }, tree);
    if (prev && diff.empty) throw fail(400, "NO_CHANGES", "The draft is the same as the published version");
    const next = t.currentVersion + 1;
    let v;
    try {
      v = await WorkflowTemplateVersion.create({ templateId: t._id, version: next, tree, summary: summaryJson(diff), publishedBy: actor._id });
    } catch (err) {
      if (err.code === 11000) throw fail(409, "VERSION_TAKEN", "Someone published just now. Reload.");
      throw err;
    }
    const moved = await WorkflowTemplate.updateOne(
      { _id: t._id, currentVersion: t.currentVersion, draftRevision: revision },
      { $set: { currentVersion: next, currentVersionId: v._id, draft: null, updatedBy: actor._id }, $inc: { draftRevision: 1 } }
    );
    if (!moved.modifiedCount) {
      await WorkflowTemplateVersion.deleteOne({ _id: v._id });
      throw fail(409, "DRAFT_CHANGED", "The draft changed while publishing");
    }
    return { version: next, summary: summaryJson(diff) };
  });

/** The standard every new company starts with (exactly one; partial unique index). */
const setDefault = (actor, id) =>
  sys(async () => {
    const t = await WorkflowTemplate.findById(id).select("currentVersionId archived").lean();
    if (!t) throw new ApiError(404, "Standard workflow not found");
    if (!t.currentVersionId) throw fail(400, "NOT_PUBLISHED", "Publish it before making it the default");
    if (t.archived) throw fail(400, "ARCHIVED", "Restore it before making it the default");
    await WorkflowTemplate.updateMany({ defaultForNewCompanies: true, _id: { $ne: id } }, { $set: { defaultForNewCompanies: false } });
    await WorkflowTemplate.updateOne({ _id: id }, { $set: { defaultForNewCompanies: true, updatedBy: actor._id } });
    return listTemplates();
  });

module.exports = {
  ensureStandard,
  defaultForNewCompany,
  latestVersion,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  saveTemplateDraft,
  publishTemplate,
  setDefault
};
