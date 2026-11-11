const Workflow = require("./models/Workflow");
const WorkflowVersion = require("./models/WorkflowVersion");
const versionCache = require("./versionCache");
const templates = require("./template.service");
const { createOrgCache } = require("../../utils/orgCache");
const logger = require("../../utils/logger");

/**
 * An organisation's workflow (project-workflow-plan.md §7.3, §7.5).
 *
 * First use per organisation: a copy of the default standard workflow becomes its
 * version 1 (W1). This covers new organisations and every existing one, so no
 * start-up step is needed; projects created before workflows existed fall back to
 * version 1, which is the Basic workflow with the same stage keys.
 *
 * The "current" pointer is cached per organisation (30 s TTL, cleared on publish);
 * compiled versions are cached for good in versionCache.
 */
const cache = createOrgCache({ ttlMs: 30 * 1000 });

const createFromStandard = async () => {
  const { template, version } = await templates.defaultForNewCompany();
  let wf;
  try {
    wf = await Workflow.create({ basedOn: { templateId: template._id, version: version.version, tree: version.tree } });
  } catch (err) {
    if (err.code === 11000) return Workflow.findOne({ scope: "projects" }).lean(); // another request made it
    throw err;
  }
  const v1 = await WorkflowVersion.create({ workflowId: wf._id, version: 1, tree: version.tree, source: "standard" });
  await Workflow.updateOne({ _id: wf._id, currentVersion: 0 }, { $set: { currentVersion: 1, currentVersionId: v1._id } });
  logger.info(`[Workflows] Organisation started from the standard workflow "${template.name}" v${version.version}`);
  return Workflow.findById(wf._id).lean();
};

const loadCurrent = async () => {
  let wf = await Workflow.findOne({ scope: "projects" }).lean();
  if (!wf) wf = await createFromStandard();
  if (!wf.currentVersionId) {
    // Created by a request that hasn't finished yet: its version 1 is about to exist
    const v1 = await WorkflowVersion.findOne({ workflowId: wf._id, version: 1 }).select("_id").lean();
    if (!v1) throw new Error("Workflow is still being set up. Try again.");
    wf = { ...wf, currentVersion: 1, currentVersionId: v1._id };
  }
  const first = wf.currentVersion === 1 ? { _id: wf.currentVersionId } : await WorkflowVersion.findOne({ workflowId: wf._id, version: 1 }).select("_id").lean();
  return { workflow: wf, currentVersionId: String(wf.currentVersionId), firstVersionId: String(first._id) };
};

/** The organisation's workflow document and the ids of its current and first versions. */
const current = () => cache.get(loadCurrent);

/** Compiled current version (what new projects follow). */
const currentCompiled = async () => versionCache.get((await current()).currentVersionId);

/** Compiled version a project follows (older projects: version 1, the Basic stages). */
const compiledForProject = async (project) => {
  if (project?.flow?.versionId) return versionCache.get(project.flow.versionId);
  return versionCache.get((await current()).firstVersionId);
};

const invalidate = () => cache.invalidate();

module.exports = { current, currentCompiled, compiledForProject, invalidate };
