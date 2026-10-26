const { createRouteTrie } = require("../utils/routeTrie");
const modules = require("./modules");

/**
 * Which module each API path belongs to (paths relative to /api/v1; ":x" matches
 * one segment). The longest matching prefix wins, so a specific path can belong to
 * a different module than its parent (e.g. /uploads/avatar is core, /uploads is tasks).
 *
 * Deny by default: a path that matches nothing is refused by the module gate, and
 * tests/moduleGate.test.js fails if any real route is left unmapped.
 */
const MODULE_ROUTES = [
  // ── Core ────────────────────────────────────────────────────────────────────
  ["/auth", "core"],
  ["/users", "core"],
  ["/notifications", "core"],
  ["/push", "core"],
  // Each person's encryption keys: identity, used by chat AND the planner, so not gated by Chat
  ["/chat/keys", "core"],
  ["/uploads/avatar", "core"],
  ["/dashboard/audit-logs", "core"],
  ["/admin/settings", "core"],
  ["/platform", "core"], // the product owner's console (role-gated separately)
  ["/org", "organisation"],
  ["/privacy", "privacy"],
  ["/admin/privacy", "privacy"],

  // ── Tasks ───────────────────────────────────────────────────────────────────
  ["/tasks", "tasks"],
  ["/comments", "tasks"],
  ["/uploads", "tasks"], // task and comment attachments
  ["/dashboard", "tasks"],

  // ── Projects ────────────────────────────────────────────────────────────────
  ["/admin/projects", "projects"],
  ["/projects", "projects"],

  // ── Chat ────────────────────────────────────────────────────────────────────
  ["/chat", "chat"],
  ["/quick-replies", "chat"],
  ["/sla", "chat"], // reply timers on project chats

  // ── Customer portal ─────────────────────────────────────────────────────────
  ["/admin/monitoring/customers", "customer_portal"],

  // ── Leads ───────────────────────────────────────────────────────────────────
  ["/admin/leads", "leads"],
  ["/campaigns/:id/lead", "leads"],
  ["/admin/campaigns/:id/leads", "leads"], // customers' contact details: Leads, not Marketing

  // ── Marketing ───────────────────────────────────────────────────────────────
  ["/campaigns", "marketing"],
  ["/catalog", "marketing"],
  ["/testimonials", "marketing"],
  ["/admin/campaigns", "marketing"],
  ["/admin/catalog", "marketing"],
  ["/admin/testimonials", "marketing"],
  ["/admin/media", "marketing"],

  // ── Payments and referrals ──────────────────────────────────────────────────
  ["/payments", "payments"],
  ["/admin/payments", "payments"],
  ["/referrals", "referrals"],
  ["/admin/referrals", "referrals"],

  // ── Performance ─────────────────────────────────────────────────────────────
  ["/admin/monitoring", "performance"],
  ["/admin/sla", "performance"],

  // ── Reports and ratings ─────────────────────────────────────────────────────
  ["/reports", "reports"],
  ["/admin/reports", "reports"],
  ["/ratings", "reports"],

  // ── Moderation ──────────────────────────────────────────────────────────────
  ["/moderation", "moderation"],
  ["/admin/moderation", "moderation"]
];

// Packaged modules bring their own paths (backend/src/modules/*/manifest.js)
for (const m of require("../modules/catalog").MANIFESTS) for (const p of m.paths || []) MODULE_ROUTES.push([p, m.key]);

for (const [pattern, key] of MODULE_ROUTES) {
  if (!modules.isModule(key)) throw new Error(`Route "${pattern}" names unknown module "${key}"`);
}

const trie = createRouteTrie(MODULE_ROUTES);

/** Module key for a normalised path (see accessPolicy.normalisePath), or null if unmapped. */
const moduleForPath = (path) => trie.lookup(path);

/**
 * Paths that need the organisation to have their module, but not a personal
 * grant. Reporting is a safety action: any designer in a project chat must be
 * able to flag an abusive customer (and answer a report about them, and see
 * their own rating), not only the people given "Reports and ratings" to review
 * reports (/admin/reports stays granted). Who may report whom is checked by
 * report.service (members of that project chat, customer ↔ staff only).
 */
const ORG_WIDE_ROUTES = ["/reports", "/ratings"];
for (const p of ORG_WIDE_ROUTES) {
  if (!moduleForPath(p)) throw new Error(`Org-wide route "${p}" isn't mapped to a module`);
}
const orgWideTrie = createRouteTrie(ORG_WIDE_ROUTES.map((p) => [p, true]));

/** Same longest-prefix walk as moduleForPath: O(path segments). */
const isOrgWidePath = (path) => orgWideTrie.lookup(path) === true;

module.exports = { MODULE_ROUTES, moduleForPath, ORG_WIDE_ROUTES, isOrgWidePath };
