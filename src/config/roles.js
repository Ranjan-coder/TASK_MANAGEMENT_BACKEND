/**
 * Single source of truth for account roles.
 *
 * - STAFF_ROLES: Bonito employees (use the staff app)
 * - PRIVILEGED_ROLES: accounts that must use 2FA and can change org-wide content
 * - "customer": end clients — restricted to the customer portal (see accessPolicy.js)
 */
const ROLES = Object.freeze({
  SUPERADMIN: "superadmin",
  ADMIN: "admin",
  MARKETING: "marketing",
  USER: "user",
  CUSTOMER: "customer"
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));
const STAFF_ROLES = Object.freeze([ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MARKETING, ROLES.USER]);
const PRIVILEGED_ROLES = Object.freeze([ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MARKETING]);
const ADMIN_ROLES = Object.freeze([ROLES.SUPERADMIN, ROLES.ADMIN]);

// Roles an "admin" (not superadmin) may assign or manage.
const ADMIN_MANAGEABLE_ROLES = Object.freeze([ROLES.USER, ROLES.MARKETING, ROLES.CUSTOMER]);

module.exports = {
  ROLES,
  ALL_ROLES,
  STAFF_ROLES,
  PRIVILEGED_ROLES,
  ADMIN_ROLES,
  ADMIN_MANAGEABLE_ROLES
};
