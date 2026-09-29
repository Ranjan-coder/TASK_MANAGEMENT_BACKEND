const express = require("express");
const multer = require("multer");
const controller = require("../controllers/report.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const { createLimiter } = require("../middlewares/rateLimiter.middleware");
const { MAX_EVIDENCE_BYTES } = require("../services/media.service");
const v = require("../validators/report.validator");

const PROJECT_PEOPLE = ["customer", "user", "admin", "superadmin"];

const screenshots = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: 5, fields: 2, fieldSize: 200 * 1024 }
});
const reportLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many reports in a short time. Please try again later."
});

// Customers report staff; staff flag customers (their project chats only)
const reportRoutes = express.Router();
reportRoutes.use(authMiddleware, rbacMiddleware(...PROJECT_PEOPLE));
reportRoutes.post("/", reportLimiter, screenshots.array("screenshots", 5), controller.createReport);
reportRoutes.get("/mine", controller.listMine);
reportRoutes.get("/about-me", controller.listAboutMe);
reportRoutes.post("/:id/response", validate(v.respondSchema), controller.respond);

const ratingRoutes = express.Router();
ratingRoutes.use(authMiddleware);
ratingRoutes.get("/me", rbacMiddleware("user", "admin", "superadmin"), controller.getOwnRatingSummary);
ratingRoutes.get("/:conversationId/mine", rbacMiddleware("customer"), validate(v.ratingConvSchema), controller.getMyRating);
ratingRoutes.put("/:conversationId", rbacMiddleware("customer"), validate(v.ratingSchema), controller.putRating);

const adminReportRoutes = express.Router();
adminReportRoutes.use(authMiddleware, rbacMiddleware("superadmin", "admin"));
adminReportRoutes.get("/", validate(v.adminListSchema), controller.adminList);
adminReportRoutes.get("/:id", validate(v.reportIdSchema), controller.adminGet);
adminReportRoutes.patch("/:id", validate(v.adminReviewSchema), controller.adminReview);

module.exports = { reportRoutes, ratingRoutes, adminReportRoutes };
