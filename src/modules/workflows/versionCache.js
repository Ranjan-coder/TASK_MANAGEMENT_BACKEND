const WorkflowVersion = require("./models/WorkflowVersion");
const { compile } = require("./engine/compile");
const tenant = require("../../utils/tenantContext");

/**
 * Compiled workflow versions, cached for good (project-workflow-plan.md §6).
 * A version never changes after publishing, so an entry can't go stale and there
 * is no TTL: just an LRU bound on how many stay in memory.
 *
 * Keyed by version id (globally unique). A project only ever references its own
 * organisation's versions (the server writes them), and the load itself runs in
 * the caller's organisation context, so one organisation can't load another's.
 */
const MAX = 2000;
const entries = new Map(); // versionId → compiled (Map insertion order = LRU)
const loading = new Map(); // versionId → Promise (single flight)

const remember = (id, compiled) => {
  entries.delete(id);
  entries.set(id, compiled);
  if (entries.size > MAX) entries.delete(entries.keys().next().value);
  return compiled;
};

// A cached entry is only handed to its own organisation (same rule as the database read)
const ownedHere = (compiled) => {
  const scope = tenant.scope();
  return scope === tenant.SYSTEM || String(compiled.orgId) === String(scope);
};

/** Compiled version by id (from memory, or one database read). */
const get = async (versionId) => {
  const id = String(versionId);
  const hit = entries.get(id);
  if (hit) return ownedHere(hit) ? remember(id, hit) : null;
  if (!loading.has(id)) {
    loading.set(
      id,
      (async () => {
        const doc = await WorkflowVersion.findById(id).select("tree version orgId").lean();
        if (!doc) return null;
        return remember(id, compile(doc.tree, { versionId: id, version: doc.version, orgId: doc.orgId }));
      })().finally(() => loading.delete(id))
    );
  }
  const compiled = await loading.get(id);
  return compiled && ownedHere(compiled) ? compiled : null;
};

/** Compile a version document we already have (e.g. just published) and keep it. */
const put = (doc) => remember(String(doc._id), compile(doc.tree, { versionId: doc._id, version: doc.version, orgId: doc.orgId }));

const clear = () => entries.clear();

module.exports = { get, put, clear, size: () => entries.size };
