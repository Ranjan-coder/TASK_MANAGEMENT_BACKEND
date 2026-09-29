const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const reportService = require("../services/report.service");
const ratingService = require("../services/rating.service");
const { recordAuditLog } = require("../services/audit.service");
const { reportPayload } = require("../validators/report.validator");

/** POST /reports — multipart: `data` (JSON) + up to 5 `screenshots`. */
const createReport = asyncHandler(async (req, res) => {
  let raw;
  try {
    raw = JSON.parse(req.body?.data || "{}");
  } catch {
    throw new ApiError(400, "Invalid report data");
  }
  const parsed = reportPayload.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, "Validation failed", parsed.error.errors.map((e) => ({ path: e.path.join("."), message: e.message })));
  }
  const report = await reportService.createReport({ reporter: req.user, ...parsed.data, files: req.files || [] });
  await recordAuditLog({
    req,
    action: "report_created",
    targetType: "User",
    targetId: report.reportedUser,
    metadata: { reportId: report._id, ticketNo: report.ticketNo, reason: report.reason, direction: report.direction }
  });
  res.status(201).json(
    new ApiResponse(201, { _id: report._id, ticketNo: report.ticketNo, status: report.status }, `Report #${report.ticketNo} received — we'll review it within 48 hours`)
  );
});

const listMine = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await reportService.listMine(req.user._id)));
});

const listAboutMe = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await reportService.listAboutMe(req.user._id)));
});

const respond = asyncHandler(async (req, res) => {
  const report = await reportService.respond({ reportId: req.params.id, user: req.user, text: req.body.text });
  await recordAuditLog({ req, action: "report_response", targetType: "User", targetId: req.user._id, metadata: { reportId: report._id } });
  res.status(200).json(new ApiResponse(200, { ok: true }, "Response sent"));
});

// ── Admin ──
const adminList = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await reportService.listForAdmin({ ...req.query, viewer: req.user })));
});

const adminGet = asyncHandler(async (req, res) => {
  const report = await reportService.getForAdmin(req.params.id, req.user);
  await recordAuditLog({ req, action: "report_viewed", targetType: "User", targetId: report.reportedUser?._id, metadata: { reportId: report._id } });
  res.status(200).json(new ApiResponse(200, report));
});

const adminReview = asyncHandler(async (req, res) => {
  const { report, changes } = await reportService.reviewReport({ reportId: req.params.id, admin: req.user, ...req.body });
  await recordAuditLog({
    req,
    action: "report_reviewed",
    targetType: "User",
    targetId: report.reportedUser,
    metadata: { reportId: report._id, ticketNo: report.ticketNo, changes, action: report.resolution?.action || null }
  });
  res.status(200).json(new ApiResponse(200, await reportService.getForAdmin(report._id), "Report updated"));
});

// ── Ratings ──
const getMyRating = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await ratingService.getMine(req.params.conversationId, req.user)));
});

const putRating = asyncHandler(async (req, res) => {
  const rating = await ratingService.upsert({ conversationId: req.params.conversationId, customer: req.user, ...req.body });
  res.status(200).json(new ApiResponse(200, rating, "Thanks for your rating"));
});

const getOwnRatingSummary = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await ratingService.getDesignerOwnSummary(req.user._id)));
});

module.exports = { createReport, listMine, listAboutMe, respond, adminList, adminGet, adminReview, getMyRating, putRating, getOwnRatingSummary };
