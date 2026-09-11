const express = require("express");
const router = express.Router();

const dashboardController = require("../controllers/dashboard.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");

router.use(authMiddleware);

// Role-scoped summary (users see own, admins/superadmins see org-wide)
router.get("/summary", dashboardController.getDashboardSummary);

// Team performance report (admin + superadmin)
router.get(
  "/team-performance",
  rbacMiddleware("admin", "superadmin"),
  dashboardController.getTeamPerformance
);

// Audit log viewer (superadmin only)
router.get(
  "/audit-logs",
  rbacMiddleware("superadmin"),
  dashboardController.getAuditLogs
);

module.exports = router;
