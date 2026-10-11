/**
 * Module catalog (module-access-plan.md). The product owner switches modules on
 * per organisation (Phase 2); the organisation's superadmin then grants them to
 * people (Phase 4). Core modules are always on and can't be switched off.
 *
 * Data structures
 * - Each module has an EXPLICIT bit. Bits are append-only: never reuse or
 *   renumber one, or stored masks would silently change meaning. A new module
 *   takes the next free bit (max 30, so masks stay small integers).
 * - `requires` forms a dependency graph. At load it is checked to be a DAG
 *   (Kahn's topological sort; a cycle stops the server from starting), then
 *   the transitive closures are precomputed as bitmasks:
 *     REQUIRES_MASK[key]   everything key needs, directly or not
 *     DEPENDENTS_MASK[key] everything that needs key, directly or not
 *   so "what does switching this on pull in" and "what would switching this off
 *   break" are each one lookup.
 * - Options (precomputed as masks, so every check stays one AND):
 *     defaultOn      on for every organisation and every eligible person unless the
 *                    product owner switches it off; never takes seats
 *     audience       "staff" keeps it away from customers...
 *     customerOptIn  ...unless the organisation's superadmin opens it to them
 *     orgWide        a setting of the whole organisation (e.g. branding): everyone in
 *                    it has the module while the organisation does; never given
 *                    person by person and never takes seats
 */

const { MANIFESTS } = require("../modules/catalog");

const MODULE_LIST = Object.freeze([
  // ── Core: always on ────────────────────────────────────────────────────────
  { key: "core", bit: 0, core: true, label: "Users and sign-in", description: "Accounts, roles, profiles, devices, notifications and the audit log." },
  { key: "organisation", bit: 1, core: true, label: "Departments and org chart", description: "Departments, designations, reporting lines and teams." },
  { key: "privacy", bit: 2, core: true, label: "Privacy (DPDP)", description: "Data export and deletion requests. A legal requirement, so always on." },

  // ── Switched on per organisation by the product owner ──────────────────────
  { key: "tasks", bit: 3, label: "Tasks", description: "Tasks, comments, attachments and the task dashboard.", requires: [] },
  { key: "projects", bit: 4, label: "Projects", description: "Customer projects and their teams.", requires: [] },
  { key: "chat", bit: 5, label: "Project chat", description: "End-to-end encrypted project chat, quick replies and design approvals.", requires: ["projects"] },
  { key: "customer_portal", bit: 6, label: "Customer portal", description: "Customer sign-in, home screen and project timeline.", requires: ["projects"] },
  { key: "leads", bit: 7, label: "Leads", description: "Consultation requests and follow-up.", requires: [] },
  { key: "marketing", bit: 8, label: "Marketing", description: "Campaigns, catalog and testimonials.", requires: [] },
  { key: "payments", bit: 9, label: "Payments", description: "Payment schedules, customer payment claims, receipts and invoices.", requires: ["projects"] },
  { key: "referrals", bit: 10, label: "Referrals", description: "Customer referral codes and rewards.", requires: ["customer_portal"] },
  { key: "performance", bit: 11, label: "Performance", description: "Business overview, designer performance and reply-time targets.", requires: [] },
  { key: "reports", bit: 12, label: "Reports and ratings", description: "Customer reports about staff and designer ratings.", requires: ["chat"] },
  { key: "moderation", bit: 13, label: "Moderation", description: "On-device abuse detection and the moderation queue.", requires: ["chat"] },
  // bit 14: planner (manifest below)
  {
    key: "branding",
    bit: 15,
    orgWide: true,
    label: "Company branding",
    description: "Shows the organisation's own name across the app (set by the product owner) instead of the product name.",
    requires: []
  },

  // ── Packaged modules (backend/src/modules/*/manifest.js) ───────────────────
  // Only the catalog fields are taken here; routes, pages, events and jobs are read
  // from the same manifests by moduleRoutes.js, modules/index.js and the jobs.
  ...MANIFESTS.map(({ key, bit, label, description, requires, defaultOn, audience, customerOptIn }) => ({
    key,
    bit,
    label,
    description,
    requires: requires || [],
    defaultOn: Boolean(defaultOn),
    audience: audience || "all",
    customerOptIn: Boolean(customerOptIn)
  }))
]);

const MAX_BIT = 30;

/** Kahn's algorithm: modules in dependency order, or throws on a cycle / bad reference. */
const topoSort = (list) => {
  const byKey = new Map(list.map((m) => [m.key, m]));
  const indegree = new Map(list.map((m) => [m.key, 0]));
  const dependents = new Map(list.map((m) => [m.key, []]));
  for (const m of list) {
    for (const dep of m.requires || []) {
      if (!byKey.has(dep)) throw new Error(`Module "${m.key}" requires unknown module "${dep}"`);
      indegree.set(m.key, indegree.get(m.key) + 1);
      dependents.get(dep).push(m.key);
    }
  }
  const queue = list.filter((m) => indegree.get(m.key) === 0).map((m) => m.key);
  const order = [];
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i];
    order.push(key);
    for (const next of dependents.get(key)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== list.length) {
    const stuck = list.filter((m) => !order.includes(m.key)).map((m) => m.key);
    throw new Error(`Module dependencies form a cycle: ${stuck.join(", ")}`);
  }
  return order;
};

/** Validates the catalog and precomputes every lookup. Exported for tests. */
const buildRegistry = (list) => {
  const keys = new Set();
  const bits = new Set();
  for (const m of list) {
    if (keys.has(m.key)) throw new Error(`Duplicate module key "${m.key}"`);
    if (!Number.isInteger(m.bit) || m.bit < 0 || m.bit > MAX_BIT) throw new Error(`Module "${m.key}" has an invalid bit`);
    if (bits.has(m.bit)) throw new Error(`Module "${m.key}" reuses bit ${m.bit}`);
    if (m.core && (m.requires || []).length) throw new Error(`Core module "${m.key}" can't depend on others`);
    if (m.customerOptIn && m.audience !== "staff") throw new Error(`Module "${m.key}": customerOptIn only applies to staff-only modules`);
    if (m.orgWide && (m.core || m.defaultOn || m.audience === "staff")) throw new Error(`Module "${m.key}": orgWide can't be combined with core, defaultOn or a staff-only audience`);
    keys.add(m.key);
    bits.add(m.bit);
  }

  const order = topoSort(list);
  const BIT = Object.fromEntries(list.map((m) => [m.key, 1 << m.bit]));
  const byKey = new Map(list.map((m) => [m.key, m]));

  // Closure in topological order: each module's deps are complete before it is seen
  const REQUIRES_MASK = {};
  for (const key of order) {
    REQUIRES_MASK[key] = (byKey.get(key).requires || []).reduce((mask, dep) => mask | BIT[dep] | REQUIRES_MASK[dep], 0);
  }
  const DEPENDENTS_MASK = Object.fromEntries(list.map((m) => [m.key, 0]));
  for (const m of list) {
    for (const other of list) if (REQUIRES_MASK[other.key] & BIT[m.key]) DEPENDENTS_MASK[m.key] |= BIT[other.key];
  }

  const CORE_MASK = list.filter((m) => m.core).reduce((mask, m) => mask | BIT[m.key], 0);
  const ALL_MASK = list.reduce((mask, m) => mask | BIT[m.key], 0);
  const maskWhere = (pred) => list.filter(pred).reduce((mask, m) => mask | BIT[m.key], 0);
  const DEFAULT_ON_MASK = maskWhere((m) => m.defaultOn);
  const STAFF_ONLY_MASK = maskWhere((m) => m.audience === "staff");
  const CUSTOMER_OPT_IN_MASK = maskWhere((m) => m.customerOptIn);
  const ORG_WIDE_MASK = maskWhere((m) => m.orgWide);

  const toMask = (moduleKeys = []) => moduleKeys.reduce((mask, k) => mask | (BIT[k] || 0), 0);
  const fromMask = (mask) => order.filter((k) => mask & BIT[k]);

  /**
   * Which modules are really usable, given the ones switched on: a module only
   * counts if everything it requires counts too. One pass in topological order.
   */
  const effectiveMask = (onMask) => {
    let mask = CORE_MASK;
    for (const key of order) {
      if (onMask & BIT[key] && (REQUIRES_MASK[key] & mask) === REQUIRES_MASK[key]) mask |= BIT[key];
    }
    return mask;
  };

  return {
    MODULES: list,
    MODULE_KEYS: order,
    TOGGLEABLE_KEYS: order.filter((k) => !byKey.get(k).core),
    BIT,
    REQUIRES_MASK,
    DEPENDENTS_MASK,
    CORE_MASK,
    ALL_MASK,
    DEFAULT_ON_MASK,
    STAFF_ONLY_MASK,
    CUSTOMER_OPT_IN_MASK,
    ORG_WIDE_MASK,
    CUSTOMER_OPT_IN_KEYS: order.filter((k) => byKey.get(k).customerOptIn),
    toMask,
    fromMask,
    effectiveMask,
    isModule: (key) => byKey.has(key),
    isCore: (key) => Boolean(byKey.get(key)?.core),
    isDefaultOn: (key) => Boolean(byKey.get(key)?.defaultOn),
    isOrgWide: (key) => Boolean(byKey.get(key)?.orgWide),
    getModule: (key) => byKey.get(key) || null
  };
};

module.exports = { ...buildRegistry(MODULE_LIST), buildRegistry };
