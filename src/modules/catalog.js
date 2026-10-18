/**
 * Every module packaged as a manifest (backend/src/modules/<name>/manifest.js).
 * Adding a module = one folder + one line here. The registry (config/modules.js),
 * route map (config/moduleRoutes.js), app (modules/index.js), socket gate and
 * background jobs all read from this list.
 */
const MANIFESTS = Object.freeze([require("./planner/manifest"), require("./workflows/manifest")]);

module.exports = { MANIFESTS };
