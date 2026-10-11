const { MANIFESTS } = require("./catalog");

/**
 * Wires packaged modules into the app (module-access-plan.md / planner-module-plan.md):
 * each manifest's router is mounted under /api/v1 at its first path. The module
 * gate (config/moduleRoutes.js) already knows those paths from the same manifest,
 * so a module can't be reachable without being gated.
 */
const mountAll = (app) => {
  for (const m of MANIFESTS) {
    if (!m.router) continue;
    app.use(`/api/v1${m.paths[0]}`, m.router());
  }
};

/** Background jobs of every packaged module: [{ label, module, run }]. */
const allJobs = () => MANIFESTS.flatMap((m) => (m.jobs || []).map((j) => ({ ...j, module: m.key })));

module.exports = { mountAll, allJobs };
