const { ROLES } = require("./roles");

/**
 * Add-on permissions a superadmin can grant to one person without giving them a
 * bigger role (e.g. Finance confirms payments, Sales works leads). Admins and
 * superadmins already have all of these through their role.
 *
 * Each permission lists the API routes it opens (paths relative to /api/v1, same
 * format as accessPolicy.js). Routes also check it at the router (authorize()).
 *
 * Each belongs to a module (module-access-plan.md, Phase 4): it only works while the
 * organisation has that module and the person was given it (the module gate checks).
 *
 * Stored as strings on the user (readable in the audit log); checked as a bitmask,
 * so every check is O(1) however many permissions exist.
 */
const ID = "[^/]+";
const rule = (method, pattern) => ({ method, regex: new RegExp(`^${pattern}$`) });

const PERMISSIONS = Object.freeze({
  "leads.view": {
    bit: 0,
    module: "leads",
    label: "View consultation leads",
    rules: [rule("GET", "/admin/leads")]
  },
  "leads.manage": {
    bit: 1,
    module: "leads",
    label: "Work consultation leads (update status and notes)",
    rules: [rule("GET", "/admin/leads"), rule("PATCH", `/admin/leads/${ID}`)]
  },
  "payments.view": {
    bit: 2,
    module: "payments",
    label: "View payment schedules",
    rules: [rule("GET", "/admin/payments"), rule("GET", `/admin/payments/${ID}`)]
  },
  "payments.confirm": {
    bit: 3,
    module: "payments",
    label: "Confirm or reject customer payments",
    rules: [
      rule("GET", "/admin/payments"),
      rule("GET", `/admin/payments/${ID}`),
      rule("POST", `/admin/payments/${ID}/milestones/${ID}/confirm`),
      rule("POST", `/admin/payments/${ID}/milestones/${ID}/reject`)
    ]
  },
  "performance.view": {
    bit: 4,
    module: "performance",
    label: "View business overview, designer performance and reply times",
    rules: [rule("GET", "/admin/monitoring/overview"), rule("GET", "/admin/monitoring/designers"), rule("GET", "/admin/sla/metrics"), rule("GET", "/workflow/report")]
  },
  "projects.view": {
    bit: 5,
    module: "projects",
    label: "View all projects and their teams",
    rules: [rule("GET", "/admin/projects"), rule("GET", `/admin/projects/${ID}`), rule("GET", `/projects/${ID}/flow`)]
  }
});

const PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSIONS));
// Explicit, append-only bit per permission (never reuse or renumber one), so
// reordering or inserting entries above can never change what a bit means.
const BIT = Object.freeze(Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 1 << PERMISSIONS[k].bit])));
{
  const seen = new Set();
  for (const k of PERMISSION_KEYS) {
    const b = PERMISSIONS[k].bit;
    if (!Number.isInteger(b) || b < 0 || b > 30 || seen.has(b)) throw new Error(`Permission "${k}" has a missing, invalid or reused bit`);
    seen.add(b);
  }
}

// Roles that get permissions without a grant
const ROLE_IMPLIED = Object.freeze({
  [ROLES.LEADERSHIP]: ["leads.view", "payments.view", "performance.view", "projects.view"]
});
// Roles that hold everything already (never need a grant)
const FULL_ROLES = new Set([ROLES.SUPERADMIN, ROLES.ADMIN]);
// Roles a superadmin may grant add-ons to (never customers)
const GRANTABLE_ROLES = Object.freeze([ROLES.USER, ROLES.MARKETING, ROLES.LEADERSHIP]);

const toMask = (keys = []) => keys.reduce((m, k) => m | (BIT[k] || 0), 0);
const ALL_MASK = toMask(PERMISSION_KEYS);
const IMPLIED_MASK = Object.fromEntries(Object.entries(ROLE_IMPLIED).map(([r, keys]) => [r, toMask(keys)]));

/** Bitmask of everything this person may do beyond their base role. */
const permissionMask = (user) => {
  if (!user) return 0;
  if (FULL_ROLES.has(user.role)) return ALL_MASK;
  if (user.role === ROLES.CUSTOMER) return 0; // grants never apply to customers
  const own = GRANTABLE_ROLES.includes(user.role) ? toMask(user.permissions) : 0;
  return own | (IMPLIED_MASK[user.role] || 0);
};

const hasPermission = (user, key) => Boolean(BIT[key]) && (permissionMask(user) & BIT[key]) !== 0;

/** Permission names this person effectively holds (for the app's menus). */
const effectivePermissions = (user) => {
  const mask = permissionMask(user);
  return PERMISSION_KEYS.filter((k) => mask & BIT[k]);
};

/** Route rules opened by this person's add-on permissions (used by accessPolicy). */
const permissionRules = (user) => {
  const mask = permissionMask(user);
  if (!mask || FULL_ROLES.has(user.role)) return [];
  return PERMISSION_KEYS.filter((k) => mask & BIT[k]).flatMap((k) => PERMISSIONS[k].rules);
};

module.exports = {
  PERMISSIONS,
  PERMISSION_KEYS,
  GRANTABLE_ROLES,
  ROLE_IMPLIED,
  hasPermission,
  effectivePermissions,
  permissionRules,
  permissionMask
};
