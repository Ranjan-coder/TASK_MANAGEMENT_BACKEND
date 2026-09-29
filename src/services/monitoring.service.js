const mongoose = require("mongoose");
const User = require("../models/User");
const Conversation = require("../models/Conversation");
const ChatSla = require("../models/ChatSla");
const Report = require("../models/Report");
const Rating = require("../models/Rating");
const ModerationIncident = require("../models/ModerationIncident");
const Lead = require("../models/Lead");
const ApiError = require("../utils/ApiError");
const { getSlaSettings } = require("./settings.service");

/**
 * Read-only numbers for the admin monitoring pages (plan §7): the overview,
 * designer performance and the customer list. Nothing here reads chat text.
 */

const DAY = 24 * 60 * 60 * 1000;
const STAFF_ROLES = ["user", "admin", "superadmin"];
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Overview ─────────────────────────────────────────────────────────────────

const getOverview = async (now = new Date()) => {
  const d7 = new Date(+now - 7 * DAY);
  const d30 = new Date(+now - 30 * DAY);
  const overdueBefore = new Date(+now - 48 * 3600 * 1000);
  const { sla } = await getSlaSettings();
  const fastMs = sla.autoReplyMin * 60 * 1000;

  const [projects, customers, waiting, reports, moderation, ratings, leads, replies] = await Promise.all([
    Conversation.aggregate([{ $match: { project: { $exists: true, $ne: null } } }, { $group: { _id: "$project.status", n: { $sum: 1 } } }]),
    User.aggregate([
      { $match: { role: "customer" } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          verified: { $sum: { $cond: ["$phoneVerified", 1, 0] } },
          suspended: { $sum: { $cond: [{ $eq: ["$status", "suspended"] }, 1, 0] } },
          newThisWeek: { $sum: { $cond: [{ $gte: ["$createdAt", d7] }, 1, 0] } }
        }
      }
    ]),
    ChatSla.find({ open: true }).sort({ waitingSince: 1 }).limit(50).populate("conversation", "name").populate("customer", "name").populate("designer", "name").lean(),
    Report.aggregate([
      {
        $group: {
          _id: null,
          open: { $sum: { $cond: [{ $in: ["$status", ["submitted", "under_review"]] }, 1, 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "submitted"] }, { $lt: ["$createdAt", overdueBefore] }] }, 1, 0] } },
          last30: { $sum: { $cond: [{ $gte: ["$createdAt", d30] }, 1, 0] } }
        }
      }
    ]),
    ModerationIncident.aggregate([
      { $match: { status: "open" } },
      { $group: { _id: null, open: { $sum: 1 }, threats: { $sum: { $cond: [{ $eq: ["$severity", "threat"] }, 1, 0] } } } }
    ]),
    Rating.aggregate([
      { $match: { updatedAt: { $gte: d30 } } },
      { $group: { _id: null, avg: { $avg: "$stars" }, count: { $sum: 1 }, low: { $sum: { $cond: [{ $lte: ["$stars", 2] }, 1, 0] } } } }
    ]),
    Lead.aggregate([{ $match: { status: "new" } }, { $group: { _id: null, n: { $sum: 1 } } }]),
    ChatSla.aggregate([
      { $match: { waitingSince: { $gte: d7 }, resolution: "replied" } },
      { $group: { _id: null, n: { $sum: 1 }, avg: { $avg: "$replyWorkingMs" }, fast: { $sum: { $cond: [{ $lte: ["$replyWorkingMs", fastMs] }, 1, 0] } } } }
    ])
  ]);

  const byStatus = Object.fromEntries(projects.map((p) => [p._id, p.n]));
  const c = customers[0] || {};
  const r = reports[0] || {};
  const m = moderation[0] || {};
  const rt = ratings[0] || {};
  const rep = replies[0] || {};
  return {
    projects: { active: byStatus.active || 0, onHold: byStatus.on_hold || 0, completed: byStatus.completed || 0 },
    customers: { total: c.total || 0, verified: c.verified || 0, suspended: c.suspended || 0, newThisWeek: c.newThisWeek || 0 },
    waiting: {
      count: waiting.length,
      escalated: waiting.filter((w) => w.stage === "escalated").length,
      longest: waiting
        .filter((w) => w.conversation)
        .slice(0, 6)
        .map((w) => ({
          conversationId: w.conversation._id,
          projectName: w.conversation.name,
          customerName: w.customer?.name || "Customer",
          designerName: w.designer?.name || null,
          stage: w.stage,
          waitingSince: w.waitingSince,
          clockStart: w.clockStart
        }))
    },
    reports: { open: r.open || 0, overdue: r.overdue || 0, last30: r.last30 || 0 },
    moderation: { open: m.open || 0, threats: m.threats || 0 },
    ratings: { average30: round1(rt.avg), count30: rt.count || 0, low30: rt.low || 0 },
    leads: { new: leads[0]?.n || 0 },
    replies7d: {
      count: rep.n || 0,
      avgMinutes: rep.avg == null ? null : Math.round(rep.avg / 60000),
      fastRate: rep.n ? Math.round(((rep.fast || 0) / rep.n) * 100) : null,
      fastThresholdMin: sla.autoReplyMin
    }
  };
};

// ── Designer performance ─────────────────────────────────────────────────────

const slaStats = async (from, to, fastMs) => {
  const rows = await ChatSla.aggregate([
    { $match: { waitingSince: { $gte: from, $lt: to }, designer: { $ne: null } } },
    {
      $group: {
        _id: "$designer",
        periods: { $sum: 1 },
        replied: { $sum: { $cond: [{ $eq: ["$resolution", "replied"] }, 1, 0] } },
        avgMs: { $avg: { $cond: [{ $eq: ["$resolution", "replied"] }, "$replyWorkingMs", null] } },
        fast: { $sum: { $cond: [{ $and: [{ $eq: ["$resolution", "replied"] }, { $lte: ["$replyWorkingMs", fastMs] }] }, 1, 0] } },
        escalations: { $sum: { $cond: [{ $ne: ["$escalatedAt", null] }, 1, 0] } }
      }
    }
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
};

const ratingStats = async (match) => {
  const rows = await Rating.aggregate([{ $match: match }, { $group: { _id: "$designer", avg: { $avg: "$stars" }, count: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r]));
};

const getDesignerPerformance = async ({ days = 30, now = new Date() } = {}) => {
  const from = new Date(+now - days * DAY);
  const prevFrom = new Date(+now - 2 * days * DAY);
  const { sla } = await getSlaSettings();
  const fastMs = sla.autoReplyMin * 60 * 1000;

  const [cur, prev, ratingsAll, ratingsCur, ratingsPrev, reports, incidents, projects] = await Promise.all([
    slaStats(from, now, fastMs),
    slaStats(prevFrom, from, fastMs),
    ratingStats({}),
    ratingStats({ updatedAt: { $gte: from } }),
    ratingStats({ updatedAt: { $gte: prevFrom, $lt: from } }),
    Report.aggregate([
      { $match: { direction: "customer_to_staff", createdAt: { $gte: from } } },
      {
        $group: {
          _id: "$reportedUser",
          total: { $sum: 1 },
          actionTaken: { $sum: { $cond: [{ $eq: ["$status", "action_taken"] }, 1, 0] } },
          open: { $sum: { $cond: [{ $in: ["$status", ["submitted", "under_review"]] }, 1, 0] } }
        }
      }
    ]),
    ModerationIncident.aggregate([
      { $match: { createdAt: { $gte: from } } },
      { $unwind: "$offenders" },
      { $group: { _id: "$offenders.user", hits: { $sum: "$offenders.hits" }, incidents: { $sum: 1 } } }
    ]),
    Conversation.aggregate([
      { $match: { "project.status": { $in: ["active", "on_hold"] } } },
      {
        $facet: {
          lead: [{ $group: { _id: "$project.leadDesigner", n: { $sum: 1 } } }],
          backup: [{ $match: { "project.backupDesigner": { $ne: null } } }, { $group: { _id: "$project.backupDesigner", n: { $sum: 1 } } }]
        }
      }
    ])
  ]);

  const reportsBy = new Map(reports.map((r) => [String(r._id), r]));
  const incidentsBy = new Map(incidents.map((r) => [String(r._id), r]));
  const leadBy = new Map((projects[0]?.lead || []).map((r) => [String(r._id), r.n]));
  const backupBy = new Map((projects[0]?.backup || []).map((r) => [String(r._id), r.n]));

  const ids = new Set([...cur.keys(), ...prev.keys(), ...ratingsAll.keys(), ...reportsBy.keys(), ...leadBy.keys(), ...backupBy.keys()]);
  const staff = await User.find({ _id: { $in: [...ids].map(oid) }, role: { $in: STAFF_ROLES } }).select("name avatarUrl designation status availability").lean();

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const designers = staff.map((u) => {
    const id = String(u._id);
    const c = cur.get(id);
    const p = prev.get(id);
    const onLeave = u.availability?.status === "on_leave" && (!u.availability.until || new Date(u.availability.until) > now);
    return {
      designer: { _id: u._id, name: u.name, avatarUrl: u.avatarUrl, designation: u.designation, status: u.status, onLeave },
      activeProjects: { lead: leadBy.get(id) || 0, backup: backupBy.get(id) || 0 },
      replies: {
        waits: c?.periods || 0,
        avgMinutes: c?.avgMs == null ? null : Math.round(c.avgMs / 60000),
        prevAvgMinutes: p?.avgMs == null ? null : Math.round(p.avgMs / 60000),
        fastRate: pct(c?.fast || 0, c?.replied || 0),
        prevFastRate: pct(p?.fast || 0, p?.replied || 0),
        escalations: c?.escalations || 0,
        prevEscalations: p?.escalations || 0
      },
      rating: {
        average: round1(ratingsAll.get(id)?.avg),
        count: ratingsAll.get(id)?.count || 0,
        periodAverage: round1(ratingsCur.get(id)?.avg),
        prevAverage: round1(ratingsPrev.get(id)?.avg)
      },
      reports: { total: reportsBy.get(id)?.total || 0, actionTaken: reportsBy.get(id)?.actionTaken || 0, open: reportsBy.get(id)?.open || 0 },
      flaggedWords: incidentsBy.get(id)?.hits || 0
    };
  });

  designers.sort((a, b) => (b.activeProjects.lead + b.activeProjects.backup) - (a.activeProjects.lead + a.activeProjects.backup) || a.designer.name.localeCompare(b.designer.name));
  return { days, fastThresholdMin: sla.autoReplyMin, designers };
};

// ── Customers ────────────────────────────────────────────────────────────────

const CUSTOMER_FIELDS = "name email phone phoneVerified status createdAt lastLogin avatarUrl";

const listCustomers = async ({ search, status, verified, page = 1, limit = 25 }) => {
  const q = { role: "customer" };
  if (status) q.status = status;
  if (verified === "yes") q.phoneVerified = true;
  if (verified === "no") q.phoneVerified = { $ne: true };
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    const digits = search.replace(/\D/g, "");
    q.$or = [{ name: rx }, { email: rx }, ...(digits.length >= 4 ? [{ phone: new RegExp(escapeRegex(digits)) }] : [])];
  }
  const [items, total] = await Promise.all([
    User.find(q).select(CUSTOMER_FIELDS).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(q)
  ]);
  const ids = items.map((u) => u._id);
  const [projectCounts, leadCounts, reportCounts] = await Promise.all([
    Conversation.aggregate([
      { $match: { "project.customers": { $in: ids } } },
      { $unwind: "$project.customers" },
      { $match: { "project.customers": { $in: ids } } },
      { $group: { _id: "$project.customers", n: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ["$project.status", "active"] }, 1, 0] } } } }
    ]),
    Lead.aggregate([{ $match: { customer: { $in: ids } } }, { $group: { _id: "$customer", n: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ["$status", ["new", "contacted"]] }, 1, 0] } } } }]),
    Report.aggregate([{ $match: { reportedUser: { $in: ids } } }, { $group: { _id: "$reportedUser", n: { $sum: 1 } } }])
  ]);
  const map = (rows) => new Map(rows.map((r) => [String(r._id), r]));
  const p = map(projectCounts);
  const l = map(leadCounts);
  const r = map(reportCounts);
  return {
    total,
    page,
    items: items.map((u) => ({
      ...u,
      projects: { total: p.get(String(u._id))?.n || 0, active: p.get(String(u._id))?.active || 0 },
      leads: { total: l.get(String(u._id))?.n || 0, open: l.get(String(u._id))?.open || 0 },
      flagged: r.get(String(u._id))?.n || 0
    }))
  };
};

const getCustomer = async (id) => {
  const user = await User.findOne({ _id: id, role: "customer" }).select(`${CUSTOMER_FIELDS} consent`).lean();
  if (!user) throw new ApiError(404, "Customer not found");
  const [projects, leads, reportsMade, reportsAbout] = await Promise.all([
    Conversation.find({ "project.customers": user._id })
      .select("name project.status project.leadDesigner project.createdAt lastActivityAt")
      .populate("project.leadDesigner", "name")
      .sort({ lastActivityAt: -1 })
      .lean(),
    Lead.find({ customer: user._id }).populate("campaign", "title").sort({ createdAt: -1 }).limit(20).lean(),
    Report.find({ reporter: user._id }).select("ticketNo status reason createdAt reportedUser").populate("reportedUser", "name").sort({ createdAt: -1 }).limit(20).lean(),
    Report.find({ reportedUser: user._id }).select("ticketNo status reason createdAt reporter").populate("reporter", "name").sort({ createdAt: -1 }).limit(20).lean()
  ]);
  return {
    ...user,
    projects: projects.map((c) => ({ _id: c._id, name: c.name, status: c.project.status, leadDesigner: c.project.leadDesigner?.name || null, lastActivityAt: c.lastActivityAt })),
    leads: leads.map((x) => ({ _id: x._id, campaign: x.campaign?.title || null, status: x.status, message: x.message, createdAt: x.createdAt })),
    reportsMade,
    reportsAbout
  };
};

module.exports = { getOverview, getDesignerPerformance, listCustomers, getCustomer };
