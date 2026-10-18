const mongoose = require("mongoose");
const Workflow = require("./models/Workflow");
const WorkflowVersion = require("./models/WorkflowVersion");
const Conversation = require("../../models/Conversation");
const User = require("../../models/User");
const ApiError = require("../../utils/ApiError");
const logger = require("../../utils/logger");
const workflows = require("./workflow.service");
const versionCache = require("./versionCache");
const { normaliseTree, WorkflowError } = require("./engine/tree");
const { compile } = require("./engine/compile");
const { diffTrees, summaryJson } = require("./engine/diff");
const nav = require("./engine/navigate");
const { STAFF_ROLES, ROLES } = require("../../config/roles");

/**
 * Editing the organisation's workflow (project-workflow-plan.md §7.3, §7.4).
 *
 * Who (W3, C1):
 *   - superadmins and admins edit everything and publish;
 *   - a stage's handlers (named people, or the head of the stage's department)
 *     edit only that stage and publish those changes straight away; admins are
 *     told. Adding, removing or reordering stages, or changing who handles a
 *     stage, is admin-only (checked on the diff, so it can't be sneaked through).
 *
 * Concurrency: the draft carries `draftRevision`; saving and publishing are
 * conditional on it, so two editors can't overwrite each other. Version numbers
 * are unique per workflow, so two publishes can't both create "v4".
 */

const ADMIN = [ROLES.SUPERADMIN, ROLES.ADMIN];
const HISTORY_CAP = 500;
const fail = (status, code, message, extra = {}) => new ApiError(status, message, [{ code, ...extra }]);
const asApi = (err) => (err instanceof WorkflowError ? fail(400, err.code, err.message, { path: err.path }) : err);
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const loadState = async () => {
  const { workflow, currentVersionId } = await workflows.current();
  const [wf, current] = await Promise.all([Workflow.findById(workflow._id).lean(), versionCache.get(currentVersionId)]);
  const currentDoc = await WorkflowVersion.findById(currentVersionId).select("tree version").lean();
  return { wf, current, currentTree: currentDoc.tree };
};

/** Stage keys this person handles in the current version (admins: null = all). */
const handledStages = async (actor, current) => {
  if (ADMIN.includes(actor.role)) return null;
  const me = String(actor._id);
  const lists = await require("../../services/org.service").load();
  const mine = new Set();
  for (const s of current.stages) {
    const head = s.departmentId ? lists.deptById.get(String(s.departmentId))?.head : null;
    if (s.handlerSet.has(me) || (head && String(head) === me)) mine.add(s.key);
  }
  return mine;
};

/** Refuses changes outside what this person may edit. */
const assertMayChange = (handled, diff) => {
  if (handled === null) return; // admin
  if (!handled.size) throw fail(403, "NOT_STAGE_HANDLER", "Only admins and the people handling a stage can change the workflow");
  if (diff.structural) throw fail(403, "ADMIN_ONLY_CHANGE", "Adding, removing or reordering stages, or changing who handles a stage, is for admins");
  const outside = [...diff.touchedStages].filter((k) => !handled.has(k));
  if (outside.length) throw fail(403, "NOT_YOUR_STAGE", `You can only change the stages you handle (not: ${outside.join(", ")})`, { stages: outside });
};

/** Departments and handlers named on stages must exist in this organisation (handlers: active staff). */
const assertReferences = async (tree) => {
  const lists = await require("../../services/org.service").load();
  const deptIds = new Set(tree.stages.map((s) => s.departmentId).filter(Boolean));
  for (const d of deptIds) if (!lists.deptById.has(String(d))) throw fail(400, "UNKNOWN_DEPARTMENT", "A stage names a department that doesn't exist");
  const handlerIds = [...new Set(tree.stages.flatMap((s) => s.handlers))];
  if (handlerIds.length) {
    const found = await User.countDocuments({ _id: { $in: handlerIds.map(oid) }, role: { $in: STAFF_ROLES }, status: "active" });
    if (found !== handlerIds.length) throw fail(400, "UNKNOWN_HANDLER", "Stage handlers must be active staff members");
  }
};

/** What a customer would see for a project at the start of this tree. */
const customerPreview = (tree) => {
  const c = compile(tree);
  return nav.customerView(c, { stepKey: c.firstStepKey, status: "active", activated: new Set(), ticks: {}, extras: [], checks: new Set() });
};

// ── Read ──────────────────────────────────────────────────────────────────────

/** Projects per workflow version (one grouped query; older projects without a flow count as v1). */
const projectsPerVersion = async () => {
  const rows = await Conversation.aggregate([
    { $match: { project: { $exists: true, $ne: null }, "project.status": { $ne: "completed" } } },
    { $group: { _id: { $ifNull: ["$project.flow.version", 1] }, n: { $sum: 1 } } }
  ]);
  return new Map(rows.map((r) => [r._id, r.n]));
};

const editorState = async (actor) => {
  const { wf, current, currentTree } = await loadState();
  const handled = await handledStages(actor, current);
  const perVersion = await projectsPerVersion();
  const olderProjects = [...perVersion].filter(([v]) => v !== current.version).reduce((n, [, c]) => n + c, 0);
  return {
    name: wf.name,
    version: current.version,
    tree: currentTree,
    draft: wf.draft,
    draftRevision: wf.draftRevision,
    draftUpdatedAt: wf.draftUpdatedAt,
    canEdit: handled === null ? "all" : [...handled],
    olderProjects,
    preview: customerPreview(currentTree),
    // "New version available" (admins decide; W7)
    offer: handled === null ? await offer().catch(() => null) : null
  };
};

const versions = async () => {
  const [list, perVersion] = await Promise.all([
    WorkflowVersion.find().select("version source summary publishedAt publishedBy").sort({ version: -1 }).limit(100).populate("publishedBy", "name").lean(),
    projectsPerVersion()
  ]);
  return list.map((v) => ({
    version: v.version,
    source: v.source,
    publishedAt: v.publishedAt,
    publishedBy: v.publishedBy?.name || null,
    projects: perVersion.get(v.version) || 0,
    changes: v.summary ? { added: v.summary.added?.length || 0, removed: v.summary.removed?.length || 0, renamed: v.summary.renamed?.length || 0, changed: v.summary.changed?.length || 0 } : null
  }));
};

const versionTree = async (version) => {
  const v = await WorkflowVersion.findOne({ version }).select("version tree publishedAt summary").lean();
  if (!v) throw new ApiError(404, "No such version");
  return v;
};

// ── Draft ─────────────────────────────────────────────────────────────────────

const saveDraft = async (actor, { tree: raw, revision }) => {
  const { wf, current, currentTree } = await loadState();
  let tree;
  try {
    tree = normaliseTree(raw);
  } catch (err) {
    throw asApi(err);
  }
  const diff = diffTrees(currentTree, tree);
  assertMayChange(await handledStages(actor, current), diff);
  const updated = await Workflow.findOneAndUpdate(
    { _id: wf._id, draftRevision: revision },
    { $set: { draft: tree, draftUpdatedBy: actor._id, draftUpdatedAt: new Date() }, $inc: { draftRevision: 1 } },
    { new: true }
  ).lean();
  if (!updated) throw fail(409, "DRAFT_CHANGED", "Someone else changed the draft. Reload to see their changes.");
  return { draft: updated.draft, draftRevision: updated.draftRevision, summary: summaryJson(diff), preview: customerPreview(tree) };
};

const discardDraft = async (actor, { revision }) => {
  if (!ADMIN.includes(actor.role)) throw fail(403, "ADMIN_ONLY_CHANGE", "Only admins can throw away the draft");
  const { wf } = await loadState();
  const updated = await Workflow.findOneAndUpdate(
    { _id: wf._id, draftRevision: revision },
    { $set: { draft: null, pendingBase: { templateId: null, version: null, tree: null } }, $inc: { draftRevision: 1 } },
    { new: true }
  ).lean();
  if (!updated) throw fail(409, "DRAFT_CHANGED", "Someone else changed the draft. Reload first.");
  return { draftRevision: updated.draftRevision };
};

// ── Standard workflow updates (W7: offered, never pushed) ─────────────────────

/** A newer version of the standard this company started from, if it hasn't dismissed it. */
const offer = async () => {
  const { wf } = await loadState();
  if (!wf.basedOn?.templateId) return null;
  const latest = await require("./template.service").latestVersion(wf.basedOn.templateId);
  if (!latest || latest.version.version <= (wf.basedOn.version || 0)) return null;
  if (wf.dismissedTemplateVersion === latest.version.version) return null;
  const diff = diffTrees(wf.basedOn.tree || { stages: [] }, latest.version.tree);
  return {
    templateName: latest.template.name,
    fromVersion: wf.basedOn.version,
    toVersion: latest.version.version,
    summary: summaryJson(diff),
    pending: wf.pendingBase?.version === latest.version.version // already merged into the draft
  };
};

/**
 * Merges the new standard version into a draft (three-way: the standard the company
 * last took, the new standard, the company's workflow or draft). Conflicts keep the
 * company's value and are listed for the admin, who reviews and publishes.
 */
const applyOffer = async (actor) => {
  if (!ADMIN.includes(actor.role)) throw fail(403, "ADMIN_ONLY_CHANGE", "Only admins can take a standard workflow update");
  const { wf, currentTree } = await loadState();
  const o = await offer();
  if (!o) throw fail(400, "NO_UPDATE", "There's no new standard version to take");
  const latest = await require("./template.service").latestVersion(wf.basedOn.templateId);
  const { mergeTrees } = require("./engine/merge");
  const ours = wf.draft || currentTree;
  const merged = mergeTrees(wf.basedOn.tree || { stages: [] }, latest.version.tree, ours);
  let tree;
  try {
    tree = normaliseTree(merged.tree);
  } catch (err) {
    throw asApi(err);
  }
  const updated = await Workflow.findOneAndUpdate(
    { _id: wf._id, draftRevision: wf.draftRevision },
    {
      $set: {
        draft: tree,
        draftUpdatedBy: actor._id,
        draftUpdatedAt: new Date(),
        pendingBase: { templateId: wf.basedOn.templateId, version: latest.version.version, tree: latest.version.tree }
      },
      $inc: { draftRevision: 1 }
    },
    { new: true }
  ).lean();
  if (!updated) throw fail(409, "DRAFT_CHANGED", "Someone changed the draft at the same time. Try again.");
  return { draft: updated.draft, draftRevision: updated.draftRevision, conflicts: merged.conflicts, changes: merged.changes, preview: customerPreview(tree) };
};

const dismissOffer = async (actor) => {
  if (!ADMIN.includes(actor.role)) throw fail(403, "ADMIN_ONLY_CHANGE", "Only admins can dismiss a standard workflow update");
  const o = await offer();
  if (!o) return { dismissed: false };
  const { wf } = await loadState();
  await Workflow.updateOne({ _id: wf._id }, { $set: { dismissedTemplateVersion: o.toVersion } });
  return { dismissed: true, version: o.toVersion };
};

// ── Publish ───────────────────────────────────────────────────────────────────

/**
 * Publishes the draft as version N+1 (immutable). Running projects stay on their
 * version (W6). A handler publishing their own stage: admins are told (C1).
 */
const publish = async (actor, { revision }) => {
  const { wf, current, currentTree } = await loadState();
  if (!wf.draft) throw fail(400, "NO_DRAFT", "There are no changes to publish");
  if (wf.draftRevision !== revision) throw fail(409, "DRAFT_CHANGED", "The draft changed since you looked at it. Review it again before publishing.");
  let tree;
  try {
    tree = normaliseTree(wf.draft);
  } catch (err) {
    throw asApi(err);
  }
  const diff = diffTrees(currentTree, tree);
  if (diff.empty) throw fail(400, "NO_CHANGES", "The draft is the same as the current version");
  const handled = await handledStages(actor, current);
  assertMayChange(handled, diff);
  await assertReferences(tree);

  const next = current.version + 1;
  let doc;
  try {
    doc = await WorkflowVersion.create({ workflowId: wf._id, version: next, tree, source: wf.pendingBase?.templateId ? "update" : "edit", summary: summaryJson(diff), publishedBy: actor._id });
  } catch (err) {
    if (err.code === 11000) throw fail(409, "VERSION_TAKEN", "Someone published a version just now. Reload and review.");
    throw err;
  }
  // A merged standard update: this publish is what makes it the new base (W7)
  const takesUpdate = Boolean(wf.pendingBase?.templateId);
  const moved = await Workflow.updateOne(
    { _id: wf._id, currentVersion: current.version, draftRevision: revision },
    {
      $set: {
        currentVersion: next,
        currentVersionId: doc._id,
        draft: null,
        ...(takesUpdate && { basedOn: wf.pendingBase, pendingBase: { templateId: null, version: null, tree: null }, dismissedTemplateVersion: null })
      },
      $inc: { draftRevision: 1 }
    }
  );
  if (!moved.modifiedCount) {
    await WorkflowVersion.deleteOne({ _id: doc._id }); // never pointed at: safe to remove
    throw fail(409, "DRAFT_CHANGED", "The draft changed while publishing. Review it again.");
  }
  workflows.invalidate();
  versionCache.put(doc);

  if (handled !== null) await tellAdmins(actor, next, diff).catch((err) => logger.warn(`[Workflows] admin notice failed: ${err.message}`));
  const perVersion = await projectsPerVersion();
  const onOlder = [...perVersion].filter(([v]) => v !== next).reduce((n, [, c]) => n + c, 0);
  return { version: next, summary: summaryJson(diff), projectsOnOlderVersions: onOlder };
};

const tellAdmins = async (actor, version, diff) => {
  const { sendNotification } = require("../../services/notification.service");
  const admins = await User.find({ role: { $in: ADMIN }, status: "active" }).select("_id").lean();
  const stages = [...diff.touchedStages].join(", ");
  await Promise.all(
    admins.map((a) =>
      sendNotification({ recipient: a._id, type: "project_update", title: `Project workflow v${version} published`, message: `${actor.name} changed: ${stages}` }).catch(() => {})
    )
  );
};

// ── Moving running projects to the current version (W6) ──────────────────────

/**
 * Moves every project on `fromVersion` to the current version. Steps that still
 * exist keep their key; for removed ones `mapping[oldStepKey]` names the new step.
 * One bulkWrite (one updateMany per distinct old step), with a history entry each.
 * Ticks of stages whose sub-stages changed are cleared (their bits may have moved);
 * activated optional steps that no longer exist are dropped.
 */
const migrate = async (actor, { fromVersion, mapping = {} }) => {
  const { current, wf } = await loadState();
  if (fromVersion >= current.version) throw fail(400, "NOTHING_TO_MOVE", "Projects can only move to a newer version");
  const old = await versionTree(fromVersion);
  const curTree = (await WorkflowVersion.findById(current.versionId).select("tree").lean()).tree;
  const diff = diffTrees(old.tree, curTree);
  const handled = await handledStages(actor, current);
  if (handled !== null) {
    if (diff.structural) throw fail(403, "ADMIN_ONLY_CHANGE", "This update changes the stages themselves: an admin moves these projects");
    const outside = [...diff.touchedStages].filter((k) => !handled.has(k));
    if (outside.length) throw fail(403, "NOT_YOUR_STAGE", "These changes touch stages you don't handle: an admin moves these projects");
  }

  const oldC = compile(old.tree);
  const target = (key) => autoTarget(current, key) || mapping[key];
  const needs = oldC.steps.map((s) => s.key).filter((k) => !autoTarget(current, k));
  const missing = needs.filter((k) => !mapping[k] || !current.stepIndex.has(mapping[k]));
  if (missing.length) throw fail(400, "MAPPING_REQUIRED", "Choose where projects at removed steps should go", { steps: missing });
  for (const k of needs) if (current.steps[current.stepIndex.get(mapping[k])].optional) throw fail(400, "MAPPING_OPTIONAL", "Move projects to a step that always runs, not an optional one");

  const keepActivated = [...current.subPath.keys()];
  const resetTicks = Object.fromEntries([...diff.touchedStages].map((k) => [`project.flow.ticks.${k}`, ""]));
  const now = new Date();
  const ops = [];
  for (const s of oldC.steps) {
    const to = target(s.key);
    const toStage = current.stages[current.steps[current.stepIndex.get(to)].stageIdx];
    const entry = { stage: toStage.key, step: to, version: current.version, from: s.key, kind: "migrate", at: now, by: actor._id, note: `Workflow updated to v${current.version}` };
    const base = { $push: { "project.stageHistory": { $each: [entry], $slice: -HISTORY_CAP } } };
    // Projects with a stored flow on this version and step
    ops.push({
      updateMany: {
        filter: { "project.flow.version": fromVersion, "project.flow.stepKey": s.key, "project.status": { $ne: "completed" } },
        update: [
          // pipeline update: set fields and drop activations that no longer exist, in one write
          {
            $set: {
              "project.flow.versionId": oid(current.versionId),
              "project.flow.version": current.version,
              "project.flow.stepKey": to,
              "project.stage": toStage.key,
              "project.flow.activated": { $filter: { input: { $ifNull: ["$project.flow.activated", []] }, cond: { $in: ["$$this.key", keepActivated] } } },
              // $literal: the entry is a value, never read as an expression
              "project.stageHistory": { $slice: [{ $concatArrays: [{ $ifNull: ["$project.stageHistory", []] }, { $literal: [entry] }] }, -HISTORY_CAP] }
            }
          },
          ...(Object.keys(resetTicks).length ? [{ $unset: Object.keys(resetTicks) }] : [])
        ]
      }
    });
    // Projects from before workflows (no flow stored) count as version 1
    if (fromVersion === 1) {
      ops.push({
        updateMany: {
          filter: { "project.flow": { $exists: false }, "project.stage": s.key, "project.status": { $ne: "completed" } },
          update: {
            $set: {
              "project.stage": toStage.key,
              "project.flow": { versionId: oid(current.versionId), version: current.version, stepKey: to, ticks: {}, activated: [], extras: [], checks: [], enteredAt: now, stageEnteredAt: now, dueAt: null, overdueNotifiedAt: null }
            },
            ...base
          }
        }
      });
    }
  }
  const res = ops.length ? await Conversation.bulkWrite(ops, { ordered: false }) : { modifiedCount: 0 };
  logger.info(`[Workflows] Moved ${res.modifiedCount} project(s) from v${fromVersion} to v${current.version} (workflow ${wf._id})`);
  return { moved: res.modifiedCount, toVersion: current.version };
};

/**
 * Where a step of an older version goes without asking: the same step if it still
 * exists, else (its stage still exists, e.g. it gained or lost sub-stages) that
 * stage's first step that always runs. Null = the stage itself is gone: ask.
 */
const autoTarget = (current, key) => {
  if (current.stepIndex.has(key)) return key;
  const si = current.stageIndex.get(String(key).split("/")[0]);
  if (si === undefined) return null;
  const s = current.stages[si];
  for (let j = s.firstStep; j <= s.lastStep; j += 1) if (!current.steps[j].optional) return current.steps[j].key;
  return null;
};

/** For the "move projects" screen: steps of an older version that need a new place. */
const migrationPlan = async (fromVersion) => {
  const { current } = await loadState();
  const old = await versionTree(fromVersion);
  const oldC = compile(old.tree);
  const removed = oldC.steps.filter((s) => !autoTarget(current, s.key)).map((s) => ({ key: s.key, name: s.subKey ? `${oldC.stages[s.stageIdx].name} › ${oldC.subPath.get(s.key)?.sub.name}` : oldC.stages[s.stageIdx].name }));
  const targets = current.steps.filter((s) => !s.optional).map((s) => ({ key: s.key, name: s.subKey ? `${current.stages[s.stageIdx].name} › ${current.subPath.get(s.key)?.sub.name}` : current.stages[s.stageIdx].name }));
  return { fromVersion, toVersion: current.version, removed, targets };
};

module.exports = { editorState, versions, versionTree, saveDraft, discardDraft, publish, migrate, migrationPlan, customerPreview, offer, applyOffer, dismissOffer };
