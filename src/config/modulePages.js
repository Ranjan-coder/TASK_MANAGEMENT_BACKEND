/**
 * Which app screens belong to which module (the page guard and menus use it).
 * Shared with the frontend through the generated frontend/lib/generated/modules.json
 * (node scripts/genModules.js), so the two sides can't drift apart. Packaged
 * modules add their own screens in their manifest (`pages`).
 */
const PAGES = [
  ["/dashboard", "tasks"],
  ["/tasks", "tasks"],
  ["/chat", "chat"],
  ["/admin/projects", "projects"],
  ["/admin/customers", "customer_portal"],
  ["/admin/leads", "leads"],
  ["/admin/campaigns", "marketing"],
  ["/admin/catalog", "marketing"],
  ["/admin/testimonials", "marketing"],
  ["/admin/payments", "payments"],
  ["/receipts", "payments"],
  ["/home/payments", "payments"],
  ["/admin/referrals", "referrals"],
  ["/home/refer", "referrals"],
  ["/admin/overview", "performance"],
  ["/admin/performance", "performance"],
  ["/admin/reply-times", "chat"],
  ["/admin/reports", "reports"],
  ["/admin/moderation", "moderation"],
  ["/home", "customer_portal"]
];

module.exports = { PAGES };
