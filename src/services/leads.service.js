const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const User = require("../models/User");
const Testimonial = require("../models/Testimonial");
const CatalogItem = require("../models/CatalogItem");
const ApiError = require("../utils/ApiError");
const { destroyMedia } = require("./media.service");

/** Consultation requests (R2) and testimonials (R6), managed by marketing and admins. */

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PAGE = 30;

const populateLead = (q) =>
  q
    .populate("customer", "name email phone phoneVerified")
    .populate("campaign", "title")
    .populate("handledBy", "name")
    .populate("notes.by", "name");

const listLeads = async ({ status, campaign, search, page = 1 }) => {
  const q = {};
  if (status) q.status = status;
  if (campaign) q.campaign = campaign;
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    const digits = search.replace(/\D/g, "");
    const customers = await User.find({
      role: "customer",
      $or: [{ name: rx }, { email: rx }, ...(digits.length >= 4 ? [{ phone: new RegExp(digits) }] : [])]
    })
      .select("_id")
      .limit(500);
    q.customer = { $in: customers.map((c) => c._id) };
  }
  const [items, total, byStatus, byCampaign] = await Promise.all([
    populateLead(Lead.find(q).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE)).lean(),
    Lead.countDocuments(q),
    Lead.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    Lead.aggregate([
      { $group: { _id: "$campaign", total: { $sum: 1 }, converted: { $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] } } } },
      { $lookup: { from: "campaigns", localField: "_id", foreignField: "_id", as: "c" } },
      { $project: { total: 1, converted: 1, title: { $ifNull: [{ $arrayElemAt: ["$c.title", 0] }, "General enquiry"] } } },
      { $sort: { total: -1 } },
      { $limit: 20 }
    ])
  ]);
  return { items, total, page, pageSize: PAGE, counts: Object.fromEntries(byStatus.map((s) => [s._id, s.n])), campaigns: byCampaign };
};

const updateLead = async (id, actor, { status, note, assignToMe }) => {
  const lead = await Lead.findById(id);
  if (!lead) throw new ApiError(404, "Request not found");
  if (status && status !== lead.status) {
    lead.status = status;
    if (status === "contacted" && !lead.contactedAt) lead.contactedAt = new Date();
    lead.closedAt = ["converted", "closed"].includes(status) ? new Date() : null;
    if (!lead.handledBy) lead.handledBy = actor._id;
  }
  if (assignToMe) lead.handledBy = actor._id;
  if (note) lead.notes.push({ by: actor._id, text: note, at: new Date() });
  try {
    await lead.save();
  } catch (err) {
    // Reopening would clash with another open request from the same customer and campaign
    if (err.code === 11000) throw new ApiError(409, "This customer already has an open request for this campaign");
    throw err;
  }
  return populateLead(Lead.findById(lead._id)).lean();
};

// ── Testimonials ──

const publicTestimonial = (t) => ({
  _id: t._id,
  customerName: t.customerName,
  location: t.location,
  quote: t.quote,
  rating: t.rating,
  projectType: t.projectType,
  photo: t.photo?.url ? { url: t.photo.url } : null,
  portfolioSlug: t.portfolioItem?.slug || null
});

const listPublishedTestimonials = async () => {
  const rows = await Testimonial.find({ isPublished: true })
    .sort({ order: 1, createdAt: -1 })
    .limit(30)
    .populate("portfolioItem", "slug isPublished")
    .lean();
  return rows.map((t) => publicTestimonial({ ...t, portfolioItem: t.portfolioItem?.isPublished ? t.portfolioItem : null }));
};

const listAllTestimonials = () => Testimonial.find().sort({ order: 1, createdAt: -1 }).populate("portfolioItem", "name slug").lean();

const checkPortfolio = async (id) => {
  if (!id) return;
  if (!mongoose.isValidObjectId(id) || !(await CatalogItem.exists({ _id: id, kind: "portfolio" }))) {
    throw new ApiError(400, "Link a portfolio project, not a product");
  }
};

const createTestimonial = async (actor, body) => {
  await checkPortfolio(body.portfolioItem);
  return Testimonial.create({ ...body, createdBy: actor._id });
};

const updateTestimonial = async (id, body) => {
  await checkPortfolio(body.portfolioItem);
  const t = await Testimonial.findById(id);
  if (!t) throw new ApiError(404, "Testimonial not found");
  const oldPhoto = t.photo?.publicId;
  Object.assign(t, body);
  if (!body.photo) t.photo = undefined;
  await t.save();
  if (oldPhoto && oldPhoto !== t.photo?.publicId) destroyMedia(oldPhoto, "image");
  return t;
};

const deleteTestimonial = async (id) => {
  const t = await Testimonial.findByIdAndDelete(id);
  if (!t) throw new ApiError(404, "Testimonial not found");
  if (t.photo?.publicId) destroyMedia(t.photo.publicId, "image");
  return t;
};

module.exports = {
  listLeads,
  updateLead,
  listPublishedTestimonials,
  listAllTestimonials,
  createTestimonial,
  updateTestimonial,
  deleteTestimonial
};
