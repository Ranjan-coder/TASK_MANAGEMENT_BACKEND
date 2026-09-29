const Campaign = require("../models/Campaign");
const CampaignEvent = require("../models/CampaignEvent");
const CatalogItem = require("../models/CatalogItem");
const Lead = require("../models/Lead");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../utils/logger");
const { recordAuditLog } = require("../services/audit.service");
const { uploadMedia, destroyMedia } = require("../services/media.service");
const { ROLES } = require("../config/roles");

const CONTENT_MANAGERS = [ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MARKETING];

// ── Helpers ───────────────────────────────────────────────────────────────────

const istDay = (d = new Date()) => new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

const liveFilter = (now = new Date()) => ({
  status: "published",
  startAt: { $lte: now },
  $or: [{ endAt: null }, { endAt: { $gt: now } }]
});

/** What customers see: no stats, authors or internal status. */
const publicCampaign = (c) => ({
  _id: c._id,
  title: c.title,
  description: c.description,
  kind: c.kind,
  media: c.media
    ? { url: c.media.url, resourceType: c.media.resourceType, posterUrl: c.media.posterUrl, width: c.media.width, height: c.media.height }
    : null,
  offer: c.offer?.badge || c.offer?.terms ? c.offer : null,
  cta: c.cta,
  startAt: c.startAt,
  endAt: c.endAt
});

const adminCampaign = (c) => ({ ...c.toObject(), state: c.state() });

const slugify = (name) =>
  String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "item";

const uniqueSlug = async (name, excludeId = null) => {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await CatalogItem.exists({ slug: candidate, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
    if (!clash) return candidate;
  }
  return `${base}-${Date.now()}`;
};

// ── Media ─────────────────────────────────────────────────────────────────────

/** POST /admin/media?purpose=campaign|catalog  (multipart "file") */
const uploadContentMedia = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, "Choose a file to upload");
  const purpose = req.query.purpose === "catalog" ? "catalog" : "campaign";
  const media = await uploadMedia(req.file.buffer, purpose);

  await recordAuditLog({
    req,
    action: "content_media_uploaded",
    targetType: "System",
    metadata: { purpose, publicId: media.publicId, resourceType: media.resourceType, bytes: media.bytes }
  });

  res.status(201).json(new ApiResponse(201, media, "Uploaded"));
});

// ── Campaigns: admin / marketing ──────────────────────────────────────────────

const listCampaigns = asyncHandler(async (req, res) => {
  const campaigns = await Campaign.find({}).sort({ status: 1, priority: -1, startAt: -1 }).limit(500);
  res.status(200).json(new ApiResponse(200, campaigns.map(adminCampaign)));
});

const getCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) throw new ApiError(404, "Campaign not found");
  res.status(200).json(new ApiResponse(200, adminCampaign(campaign)));
});

const createCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.create({ ...req.body, createdBy: req.user._id });

  await recordAuditLog({
    req,
    action: "campaign_created",
    targetType: "System",
    targetId: campaign._id,
    metadata: { title: campaign.title, status: campaign.status }
  });

  res.status(201).json(new ApiResponse(201, adminCampaign(campaign), "Campaign saved"));
});

const updateCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) throw new ApiError(404, "Campaign not found");

  const previousStatus = campaign.status;
  const oldMedia = campaign.media;
  Object.assign(campaign, req.body, { updatedBy: req.user._id });
  if (req.body.media === null) campaign.media = undefined;
  if (req.body.offer === null) campaign.offer = undefined;
  await campaign.save();

  if (oldMedia?.publicId && oldMedia.publicId !== campaign.media?.publicId) {
    destroyMedia(oldMedia.publicId, oldMedia.resourceType);
  }

  await recordAuditLog({
    req,
    action: previousStatus !== campaign.status ? `campaign_${campaign.status}` : "campaign_updated",
    targetType: "System",
    targetId: campaign._id,
    metadata: { title: campaign.title, from: previousStatus, to: campaign.status }
  });

  res.status(200).json(new ApiResponse(200, adminCampaign(campaign), "Campaign saved"));
});

const deleteCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByIdAndDelete(req.params.id);
  if (!campaign) throw new ApiError(404, "Campaign not found");
  if (campaign.media?.publicId) destroyMedia(campaign.media.publicId, campaign.media.resourceType);
  await CampaignEvent.deleteMany({ campaign: campaign._id });

  await recordAuditLog({
    req,
    action: "campaign_deleted",
    targetType: "System",
    targetId: campaign._id,
    metadata: { title: campaign.title }
  });

  res.status(200).json(new ApiResponse(200, null, "Campaign deleted"));
});

/** Consultation requests from one campaign (contact details for follow-up). */
const listCampaignLeads = asyncHandler(async (req, res) => {
  const leads = await Lead.find({ campaign: req.params.id })
    .sort({ createdAt: -1 })
    .limit(500)
    .populate("customer", "name email phone");
  res.status(200).json(new ApiResponse(200, leads));
});

// ── Campaigns: customers ──────────────────────────────────────────────────────

/** GET /campaigns/live[?city=] — what the customer Home page shows. */
const getLiveCampaigns = asyncHandler(async (req, res) => {
  const filter = liveFilter();
  if (req.query.city) {
    filter.$and = [{ $or: [{ targetCities: { $size: 0 } }, { targetCities: req.query.city }] }];
  } else {
    filter.targetCities = { $size: 0 };
  }
  const campaigns = await Campaign.find(filter).sort({ priority: -1, startAt: -1 }).limit(20);
  res.status(200).json(new ApiResponse(200, campaigns.map(publicCampaign)));
});

/**
 * POST /campaigns/:id/events { type } — counted once per customer, per
 * campaign, per day, so stats can't be inflated by reloading.
 */
const recordCampaignEvent = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({ _id: req.params.id, ...liveFilter() }).select("_id");
  if (!campaign) throw new ApiError(404, "Campaign not available");

  try {
    await CampaignEvent.create({ campaign: campaign._id, user: req.user._id, type: req.body.type, day: istDay() });
    const field = req.body.type === "click" ? "stats.clicks" : "stats.impressions";
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { [field]: 1 } });
  } catch (err) {
    if (err.code !== 11000) throw err; // already counted today
  }
  res.status(204).end();
});

/** POST /campaigns/:id/lead { message } — "Book a free consultation". */
const requestConsultation = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({ _id: req.params.id, ...liveFilter(), "cta.type": "consultation" });
  if (!campaign) throw new ApiError(404, "This offer is no longer available");

  let lead;
  try {
    lead = await Lead.create({ customer: req.user._id, campaign: campaign._id, message: req.body.message });
  } catch (err) {
    if (err.code === 11000) {
      return res
        .status(200)
        .json(new ApiResponse(200, { alreadyRequested: true }, "We already have your request — our team will call you soon."));
    }
    throw err;
  }
  await Campaign.updateOne({ _id: campaign._id }, { $inc: { "stats.leads": 1 } });

  // Tell the people who follow up (admins + marketing)
  try {
    const { sendNotification } = require("../services/notification.service");
    const recipients = await User.find({ role: { $in: CONTENT_MANAGERS }, status: "active" }).select("_id").limit(50);
    await Promise.all(
      recipients.map((r) =>
        sendNotification({
          recipient: r._id,
          type: "consultation_request",
          title: "New consultation request",
          message: `${req.user.name} asked for a consultation from "${campaign.title}".`
        })
      )
    );
  } catch (err) {
    logger.warn(`Lead notification failed: ${err.message}`);
  }

  await recordAuditLog({ req, action: "consultation_requested", targetType: "System", targetId: lead._id, metadata: { campaign: campaign._id } });

  res.status(201).json(new ApiResponse(201, { alreadyRequested: false }, "Thanks! Our design team will call you within one working day."));
});

// ── Catalog ───────────────────────────────────────────────────────────────────

const publicCatalogItem = (i) => ({
  _id: i._id,
  kind: i.kind,
  category: i.category,
  name: i.name,
  slug: i.slug,
  summary: i.summary,
  description: i.description,
  images: i.images.map((img) => ({ url: img.url, width: img.width, height: img.height })),
  startingPrice: i.startingPrice,
  priceUnit: i.priceUnit,
  features: i.features,
  featured: i.featured,
  location: i.location || "",
  beforeImage: i.beforeImage?.url ? { url: i.beforeImage.url, width: i.beforeImage.width, height: i.beforeImage.height } : null
});

/** GET /catalog[?kind=&category=] — published items for customers. */
const listCatalog = asyncHandler(async (req, res) => {
  const filter = { isPublished: true };
  if (req.query.kind) filter.kind = req.query.kind;
  if (req.query.category) filter.category = req.query.category;
  const items = await CatalogItem.find(filter).sort({ featured: -1, order: 1, createdAt: -1 }).limit(200);
  res.status(200).json(new ApiResponse(200, items.map(publicCatalogItem)));
});

const getCatalogItem = asyncHandler(async (req, res) => {
  const item = await CatalogItem.findOne({ slug: req.params.slug, isPublished: true });
  if (!item) throw new ApiError(404, "This item isn't available");
  res.status(200).json(new ApiResponse(200, publicCatalogItem(item)));
});

const adminListCatalog = asyncHandler(async (req, res) => {
  const items = await CatalogItem.find({}).sort({ kind: 1, category: 1, order: 1 }).limit(1000);
  res.status(200).json(new ApiResponse(200, items));
});

const adminGetCatalogItem = asyncHandler(async (req, res) => {
  const item = await CatalogItem.findById(req.params.id);
  if (!item) throw new ApiError(404, "Item not found");
  res.status(200).json(new ApiResponse(200, item));
});

const createCatalogItem = asyncHandler(async (req, res) => {
  const item = await CatalogItem.create({
    ...req.body,
    slug: await uniqueSlug(req.body.name),
    createdBy: req.user._id
  });
  await recordAuditLog({ req, action: "catalog_item_created", targetType: "System", targetId: item._id, metadata: { name: item.name } });
  res.status(201).json(new ApiResponse(201, item, "Item saved"));
});

const updateCatalogItem = asyncHandler(async (req, res) => {
  const item = await CatalogItem.findById(req.params.id);
  if (!item) throw new ApiError(404, "Item not found");

  const oldImages = [...item.images.map((i) => i.publicId), item.beforeImage?.publicId].filter(Boolean);
  const nameChanged = req.body.name !== item.name;
  Object.assign(item, req.body, { updatedBy: req.user._id });
  if (!req.body.beforeImage) item.beforeImage = undefined; // full update: no "before" photo sent = removed
  if (nameChanged) item.slug = await uniqueSlug(req.body.name, item._id);
  await item.save();

  const kept = new Set([...item.images.map((i) => i.publicId), item.beforeImage?.publicId].filter(Boolean));
  oldImages.filter((p) => !kept.has(p)).forEach((p) => destroyMedia(p, "image"));

  await recordAuditLog({ req, action: "catalog_item_updated", targetType: "System", targetId: item._id, metadata: { name: item.name, published: item.isPublished } });
  res.status(200).json(new ApiResponse(200, item, "Item saved"));
});

const deleteCatalogItem = asyncHandler(async (req, res) => {
  const item = await CatalogItem.findByIdAndDelete(req.params.id);
  if (!item) throw new ApiError(404, "Item not found");
  [...item.images, item.beforeImage].filter((i) => i?.publicId).forEach((i) => destroyMedia(i.publicId, "image"));
  await recordAuditLog({ req, action: "catalog_item_deleted", targetType: "System", targetId: item._id, metadata: { name: item.name } });
  res.status(200).json(new ApiResponse(200, null, "Item deleted"));
});

module.exports = {
  CONTENT_MANAGERS,
  uploadContentMedia,
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  listCampaignLeads,
  getLiveCampaigns,
  recordCampaignEvent,
  requestConsultation,
  listCatalog,
  getCatalogItem,
  adminListCatalog,
  adminGetCatalogItem,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
  _internals: { slugify, publicCampaign, istDay }
};
