const express = require("express");
const multer = require("multer");

const content = require("../controllers/content.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const { createLimiter, uploadLimiter } = require("../middlewares/rateLimiter.middleware");
const v = require("../validators/content.validator");
const { MAX_VIDEO_BYTES } = require("../services/media.service");

// ── Customer-facing (any signed-in user) ─────────────────────────────────────

const eventLimiter = createLimiter({ windowMs: 60 * 1000, max: 120, message: "Too many requests." });
const leadLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "You've sent several requests already. Our team will be in touch soon."
});

const campaignRoutes = express.Router();
campaignRoutes.use(authMiddleware);
campaignRoutes.get("/live", validate(v.liveCampaignsSchema), content.getLiveCampaigns);
campaignRoutes.post("/:id/events", eventLimiter, validate(v.campaignEventSchema), content.recordCampaignEvent);
campaignRoutes.post("/:id/lead", leadLimiter, validate(v.leadSchema), content.requestConsultation);

const catalogRoutes = express.Router();
catalogRoutes.use(authMiddleware);
catalogRoutes.get("/", validate(v.catalogListSchema), content.listCatalog);
catalogRoutes.get("/:slug", validate(v.slugParams), content.getCatalogItem);

// ── Content manager (superadmin, admin, marketing) ───────────────────────────

// Files are checked by their actual bytes in media.service (no type filter here)
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1, fields: 5 }
});

const adminContentRoutes = express.Router();
adminContentRoutes.use(authMiddleware, rbacMiddleware(...content.CONTENT_MANAGERS));

adminContentRoutes.post("/media", uploadLimiter, mediaUpload.single("file"), content.uploadContentMedia);

adminContentRoutes.get("/campaigns", content.listCampaigns);
adminContentRoutes.post("/campaigns", validate(v.createCampaignSchema), content.createCampaign);
adminContentRoutes.get("/campaigns/:id", validate(v.idParamsSchema), content.getCampaign);
adminContentRoutes.put("/campaigns/:id", validate(v.updateCampaignSchema), content.updateCampaign);
adminContentRoutes.delete("/campaigns/:id", validate(v.idParamsSchema), content.deleteCampaign);
adminContentRoutes.get("/campaigns/:id/leads", validate(v.idParamsSchema), content.listCampaignLeads);

adminContentRoutes.get("/catalog", content.adminListCatalog);
adminContentRoutes.post("/catalog", validate(v.createCatalogSchema), content.createCatalogItem);
adminContentRoutes.get("/catalog/:id", validate(v.idParamsSchema), content.adminGetCatalogItem);
adminContentRoutes.put("/catalog/:id", validate(v.updateCatalogSchema), content.updateCatalogItem);
adminContentRoutes.delete("/catalog/:id", validate(v.idParamsSchema), content.deleteCatalogItem);

module.exports = { campaignRoutes, catalogRoutes, adminContentRoutes };
