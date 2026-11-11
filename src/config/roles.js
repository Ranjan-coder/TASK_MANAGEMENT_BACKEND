/**
 * Single source of truth for account roles.
 *
 * - STAFF_ROLES: Bonito employees (use the staff app)
 * - PRIVILEGED_ROLES: accounts that must use 2FA and can change org-wide content
 * - "customer": end clients — restricted to the customer portal (see accessPolicy.js)
 * - "platform_owner": the product owner. Sits outside every organisation (orgId null),
 *   switches modules on per organisation and never sees business data (M3). Not in
 *   ALL_ROLES, so no organisation screen or API can ever assign it.
 * - "leadership": read-only oversight (Chairman / MD / CEO): dashboards, performance,
 *   projects, payments and leads — no changes. Assigned by a superadmin only.
 */
const ROLES = Object.freeze({
  SUPERADMIN: "superadmin",
  ADMIN: "admin",
  MARKETING: "marketing",
  USER: "user",
  LEADERSHIP: "leadership",
  CUSTOMER: "customer"
});

// Roles inside an organisation (everything an organisation can assign)
const ALL_ROLES = Object.freeze(Object.values(ROLES));
// The platform tier above organisations; created only by scripts/seedPlatformOwner.js
const PLATFORM_OWNER = "platform_owner";
const STAFF_ROLES = Object.freeze([ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MARKETING, ROLES.USER, ROLES.LEADERSHIP]);
// Must use 2FA (leadership sees payments and performance across the business)
const PRIVILEGED_ROLES = Object.freeze([ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MARKETING, ROLES.LEADERSHIP, PLATFORM_OWNER]);
const ADMIN_ROLES = Object.freeze([ROLES.SUPERADMIN, ROLES.ADMIN]);

// Roles an "admin" (not superadmin) may assign or manage.
const ADMIN_MANAGEABLE_ROLES = Object.freeze([ROLES.USER, ROLES.MARKETING, ROLES.CUSTOMER]);

module.exports = {
  ROLES,
  ALL_ROLES,
  PLATFORM_OWNER,
  STAFF_ROLES,
  PRIVILEGED_ROLES,
  ADMIN_ROLES,
  ADMIN_MANAGEABLE_ROLES
};
