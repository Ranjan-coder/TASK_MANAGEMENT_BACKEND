const express = require("express");
const { z } = require("zod");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const monitoring = require("../services/monitoring.service");
const { recordAuditLog } = require("../services/audit.service");
const authorize = require("../middlewares/authorize.middleware");
const ADMIN = ["superadmin", "admin"];


const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const daysQuery = z.object({ query: z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), "Use 7, 30 or 90").optional().default(30) }).strict() });
const customersQuery = z.object({
  query: z
    .object({
      search: z.string().trim().max(80).optional(),
      status: z.enum(["active", "inactive", "suspended"]).optional(),
      verified: z.enum(["yes", "no"]).optional(),
      page: z.coerce.number().int().min(1).max(1000).optional().default(1)
    })
    .strict()
});

// Admin monitoring (read-only). Suspending uses the existing PATCH /users/:id/status.
const router = express.Router();
// Overview and designer performance: admins, or anyone with "performance.view"
// (e.g. leadership). Customer records (personal data): admins only.
router.use(authMiddleware);
const perf = authorize(ADMIN, "performance.view");
const adminOnly = rbacMiddleware(...ADMIN);

router.get("/overview", perf, asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await monitoring.getOverview()))));
router.get(
  "/designers",
  perf,
  validate(daysQuery),
  asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await monitoring.getDesignerPerformance({ days: req.query.days }))))
);
router.get(
  "/customers",
  adminOnly,
  validate(customersQuery),
  asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await monitoring.listCustomers(req.query))))
);
router.get(
  "/customers/:id",
  adminOnly,
  validate(z.object({ params: z.object({ id }) })),
  asyncHandler(async (req, res) => {
    const customer = await monitoring.getCustomer(req.params.id);
    await recordAuditLog({ req, action: "customer_viewed", targetType: "User", targetId: customer._id });
    res.status(200).json(new ApiResponse(200, customer));
  })
);

module.exports = router;
