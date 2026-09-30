const config = require("../config/env");
const { ROLES, PRIVILEGED_ROLES } = require("../config/roles");
const { permissionRules } = require("../config/permissions");

/**
 * Deny-by-default access policy, evaluated by authMiddleware on every
 * authenticated request (after the user is loaded from the database).
 *
 * Roles listed in ROLE_ALLOW_LISTS may only reach the routes listed for them.
 * Any route added later is automatically blocked for those roles until it is
 * explicitly added here. Roles NOT listed (superadmin, admin, user) fall
 * through to the existing per-route RBAC checks.
 *
 * Paths are relative to /api/v1 and matched after normalisation (see normalisePath).
 */

const ID = "[^/]+";
const rule = (method, pattern) => ({ method, regex: new RegExp(`^${pattern}$`) });

// Always reachable by any authenticated user, even while other gates apply
// (so a user can log out, see who they are, change password, set up 2FA).
const AUTH_RULES = [rule("*", "/auth(/.*)?")];

const NOTIFICATION_RULES = [
  rule("GET", "/notifications"),
  rule("PATCH", "/notifications/read-all"),
  rule("PATCH", `/notifications/${ID}/read`),
  rule("DELETE", `/notifications/${ID}`)
];

const PROFILE_RULES = [
  rule("PATCH", "/users/profile"),
  rule("POST", "/uploads/avatar")
];

// Customers may only use conversations they are already a member of
// (membership is enforced by the chat routes). They cannot create chats,
// add/remove members, rename groups or rotate group keys.
const CUSTOMER_CHAT_RULES = [
  rule("POST", "/chat/keys/publish"),
  rule("GET", "/chat/keys/bundle"),
  rule("PUT", "/chat/keys/bundle"),
  rule("GET", `/chat/keys/${ID}`),
  rule("GET", "/chat/conversations"),
  rule("GET", `/chat/conversations/${ID}`),
  rule("GET", `/chat/conversations/${ID}/messages`),
  rule("POST", `/chat/conversations/${ID}/messages`),
  rule("POST", `/chat/conversations/${ID}/attachments`),
  rule("PATCH", `/chat/messages/${ID}/read`),
  rule("PATCH", `/chat/messages/${ID}/react`),
  rule("PATCH", `/chat/messages/${ID}/edit`),
  rule("DELETE", `/chat/messages/${ID}`) // "delete for everyone" is refused in the controller
];

const STAFF_CHAT_RULES = [rule("*", "/chat(/.*)?")];

// The on-device abuse check: word list + anonymous "didn't send" counter
const MODERATION_CLIENT_RULES = [rule("GET", "/moderation/lexicon"), rule("POST", "/moderation/prevented")];

// Everyone: device push registration and their own data (DPDP export / deletion)
const PERSONAL_RULES = [
  rule("GET", "/push/vapid-key"),
  rule("POST", "/push/subscribe"),
  rule("DELETE", "/push/subscribe"),
  rule("GET", "/privacy/export"),
  rule("GET", "/privacy/deletion"),
  rule("POST", "/privacy/deletion"),
  rule("DELETE", "/privacy/deletion")
];

// Customers: their payment schedule, "I've paid", receipts/invoices, referral code
const CUSTOMER_PAYMENT_RULES = [
  rule("GET", "/payments/mine"),
  rule("POST", `/payments/${ID}/milestones/${ID}/claim`),
  rule("GET", `/payments/${ID}/milestones/${ID}/receipt`),
  rule("GET", `/payments/${ID}/milestones/${ID}/invoice`),
  rule("GET", "/referrals/mine")
];

// Customer extras: project timeline, answering design approvals, testimonials
const CUSTOMER_PROJECT_RULES = [
  rule("GET", "/projects/mine"),
  rule("GET", `/chat/conversations/${ID}/approvals`),
  rule("POST", `/chat/approvals/${ID}/decision`),
  rule("GET", "/testimonials")
];

// Reports (customer reports staff; reported customers can respond) and ratings
const CUSTOMER_REPORT_RULES = [
  rule("POST", "/reports"),
  rule("GET", "/reports/mine"),
  rule("GET", "/reports/about-me"),
  rule("POST", `/reports/${ID}/response`),
  rule("GET", `/ratings/${ID}/mine`),
  rule("PUT", `/ratings/${ID}`)
];

// Customer Home: live campaigns, view/click counters, consultation requests, catalog
const CONTENT_VIEW_RULES = [
  rule("GET", "/campaigns/live"),
  rule("POST", `/campaigns/${ID}/events`),
  rule("POST", `/campaigns/${ID}/lead`),
  rule("GET", "/catalog"),
  rule("GET", `/catalog/${ID}`)
];

// Content manager (marketing): campaigns, catalog and media uploads
const CONTENT_MANAGE_RULES = [
  rule("*", "/admin/campaigns(/.*)?"),
  rule("*", "/admin/catalog(/.*)?"),
  rule("*", "/admin/leads(/.*)?"),
  rule("*", "/admin/testimonials(/.*)?"),
  rule("GET", "/testimonials"),
  rule("POST", "/admin/media")
];

// Departments, designations, org chart and "my team" (read only; staff)
const ORG_VIEW_RULES = [
  rule("GET", "/org/departments"),
  rule("GET", "/org/designations"),
  rule("GET", "/org/chart"),
  rule("GET", "/org/team")
];

const ROLE_ALLOW_LISTS = Object.freeze({
  [ROLES.CUSTOMER]: [
    ...AUTH_RULES,
    ...NOTIFICATION_RULES,
    ...PROFILE_RULES,
    ...CUSTOMER_CHAT_RULES,
    ...CONTENT_VIEW_RULES,
    ...CUSTOMER_REPORT_RULES,
    ...MODERATION_CLIENT_RULES,
    ...CUSTOMER_PROJECT_RULES,
    ...PERSONAL_RULES,
    ...CUSTOMER_PAYMENT_RULES
  ],
  [ROLES.MARKETING]: [
    ...AUTH_RULES,
    ...NOTIFICATION_RULES,
    ...PROFILE_RULES,
    ...STAFF_CHAT_RULES,
    ...MODERATION_CLIENT_RULES,
    ...PERSONAL_RULES,
    ...CONTENT_VIEW_RULES,
    ...CONTENT_MANAGE_RULES,
    ...ORG_VIEW_RULES
  ],
  // Read-only oversight. Its dashboards, payments, projects and leads screens come
  // from the permissions the role implies (config/permissions.js ROLE_IMPLIED).
  [ROLES.LEADERSHIP]: [
    ...AUTH_RULES,
    ...NOTIFICATION_RULES,
    ...PROFILE_RULES,
    ...STAFF_CHAT_RULES,
    ...MODERATION_CLIENT_RULES,
    ...PERSONAL_RULES,
    ...ORG_VIEW_RULES
  ]
});

/**
 * Express matches routes case-insensitively and tolerates repeated or trailing
 * slashes, so normalise the same way before matching, otherwise "/API/v1//Tasks/"
 * could slip past an allow-list written for "/tasks".
 */
const normalisePath = (originalUrl) => {
  let path = String(originalUrl || "").split("?")[0].split("#")[0];
  path = path.replace(/\/{2,}/g, "/").toLowerCase();
  if (path.startsWith("/api/v1")) path = path.slice("/api/v1".length);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
};

const matches = (rules, method, path) =>
  rules.some((r) => (r.method === "*" || r.method === method) && r.regex.test(path));

const deny = (code, message) => ({ allowed: false, code, message });
const ALLOW = Object.freeze({ allowed: true });

const isPrivileged2FAEnforced = () => {
  const flag = process.env.ENFORCE_PRIVILEGED_2FA;
  if (flag === undefined || flag === "") return config.env === "production";
  return flag === "true";
};

/**
 * @returns {{allowed: boolean, code?: string, message?: string}}
 */
const evaluateAccess = ({ user, method, originalUrl }) => {
  const httpMethod = String(method || "GET").toUpperCase();
  const path = normalisePath(originalUrl);

  // Gate 1: forced password change (e.g. seeded accounts)
  if (user.mustChangePassword && !matches(AUTH_RULES, httpMethod, path)) {
    return deny("PASSWORD_CHANGE_REQUIRED", "You must change your password before continuing.");
  }

  // Gate 2: privileged accounts must have 2FA enabled — including anyone holding an
  // add-on permission (e.g. confirming payments), whatever their role
  const extraRules = permissionRules(user);
  if (
    (PRIVILEGED_ROLES.includes(user.role) || extraRules.length > 0) &&
    !user.isTwoFactorEnabled &&
    isPrivileged2FAEnforced() &&
    !matches([...AUTH_RULES, ...PROFILE_RULES], httpMethod, path)
  ) {
    return deny("TWO_FACTOR_REQUIRED", "Two-factor authentication must be enabled for this account.");
  }

  // Gate 3: role allow-lists (deny by default)
  const allowList = ROLE_ALLOW_LISTS[user.role];
  if (allowList && !matches(allowList, httpMethod, path) && !matches(extraRules, httpMethod, path)) {
    return deny("ROLE_SCOPE_DENIED", "Forbidden: this area is not available for your account type.");
  }

  // Unknown role values never get through
  if (!user.role) return deny("ROLE_SCOPE_DENIED", "Forbidden: account has no role.");

  return ALLOW;
};

module.exports = { evaluateAccess, normalisePath, ROLE_ALLOW_LISTS };
