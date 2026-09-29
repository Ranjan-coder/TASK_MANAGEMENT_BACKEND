const mongoose = require("mongoose");
const Rating = require("../models/Rating");
const Conversation = require("../models/Conversation");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { getEscalationRecipients } = require("./settings.service");

/**
 * Customer ratings of their lead designer (plan §6.2). One rating per
 * customer, designer and project; it can be changed later.
 */
const LOW_STARS = 2;
const ASK_AFTER_DAYS = 14; // first ask on an active project
const ASK_AGAIN_DAYS = 30;
const MIN_FOR_DESIGNER_VIEW = 3; // designers only see an average made of 3+ ratings (anonymity)
const DAY = 24 * 60 * 60 * 1000;

const idStr = (v) => (v ? String(v._id || v) : null);

const loadProjectForCustomer = async (conversationId, customerId) => {
  const conv = await Conversation.findOne({ _id: conversationId, "members.user": customerId }).select("name project createdAt");
  if (!conv?.project || !conv.project.customers.some((c) => idStr(c) === String(customerId))) {
    throw new ApiError(404, "Project chat not found");
  }
  return conv;
};

/** Should the app ask this customer for a rating now? */
const isPromptDue = (conv, rating, now = new Date()) => {
  if (conv.project.status === "completed") return !rating || rating.projectStatusAtRating !== "completed";
  if (conv.project.status !== "active") return false;
  const started = conv.project.createdAt || conv.createdAt;
  if (+now - +started < ASK_AFTER_DAYS * DAY) return false;
  return !rating || +now - +rating.updatedAt > ASK_AGAIN_DAYS * DAY;
};

const getMine = async (conversationId, customer) => {
  const conv = await loadProjectForCustomer(conversationId, customer._id);
  const designer = await User.findById(conv.project.leadDesigner).select("name avatarUrl");
  const rating = await Rating.findOne({ conversation: conv._id, customer: customer._id, designer: conv.project.leadDesigner });
  return {
    designer: designer ? { _id: designer._id, name: designer.name, avatarUrl: designer.avatarUrl } : null,
    rating: rating ? { stars: rating.stars, tags: rating.tags, comment: rating.comment, updatedAt: rating.updatedAt } : null,
    promptDue: isPromptDue(conv, rating)
  };
};

const upsert = async ({ conversationId, customer, stars, tags, comment }) => {
  const conv = await loadProjectForCustomer(conversationId, customer._id);
  const designerId = conv.project.leadDesigner;
  const previous = await Rating.findOne({ conversation: conv._id, customer: customer._id, designer: designerId });
  const rating = await Rating.findOneAndUpdate(
    { conversation: conv._id, customer: customer._id, designer: designerId },
    { $set: { stars, tags, comment, projectStatusAtRating: conv.project.status } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  // A new low rating (or one that just dropped to low) alerts the manager
  if (stars <= LOW_STARS && (!previous || previous.stars > LOW_STARS)) {
    const designer = await User.findById(designerId).select("name");
    const manager = idStr(conv.project.manager);
    const recipients = manager ? [manager] : (await getEscalationRecipients()).map((u) => String(u._id));
    const { sendNotification } = require("./notification.service");
    await Promise.all(
      recipients
        .filter((r) => r !== String(designerId))
        .map((recipient) =>
          sendNotification({
            recipient,
            type: "rating_alert",
            title: `Low rating: ${stars}★ for ${designer?.name || "a designer"}`,
            message: `A customer in "${conv.name}" rated their lead designer ${stars} out of 5${comment ? ": “" + comment.slice(0, 140) + "”" : "."}`
          }).catch((err) => logger.warn(`Rating alert failed: ${err.message}`))
        )
    );
  }
  return { stars: rating.stars, tags: rating.tags, comment: rating.comment, updatedAt: rating.updatedAt };
};

const summarise = async (match) => {
  const [row] = await Rating.aggregate([
    { $match: match },
    { $group: { _id: null, avg: { $avg: "$stars" }, count: { $sum: 1 }, tags: { $push: "$tags" } } }
  ]);
  if (!row) return { count: 0, average: null, tags: {} };
  const tags = {};
  for (const list of row.tags) for (const t of list) tags[t] = (tags[t] || 0) + 1;
  return { count: row.count, average: Math.round(row.avg * 10) / 10, tags };
};

/** A designer's own average: never who gave what, and only once 3+ customers have rated. */
const getDesignerOwnSummary = async (designerId) => {
  const s = await summarise({ designer: new mongoose.Types.ObjectId(String(designerId)) });
  if (s.count < MIN_FOR_DESIGNER_VIEW) return { count: s.count, average: null, tags: {}, minimum: MIN_FOR_DESIGNER_VIEW };
  return { ...s, minimum: MIN_FOR_DESIGNER_VIEW };
};

/** Per-designer averages for admins: all time and the last 90 days (trend). */
const getAdminSummaries = async (designerIds) => {
  const ids = designerIds.filter(Boolean).map((id) => new mongoose.Types.ObjectId(String(id)));
  const since = new Date(Date.now() - 90 * DAY);
  const rows = await Rating.aggregate([
    { $match: { designer: { $in: ids } } },
    {
      $group: {
        _id: "$designer",
        avg: { $avg: "$stars" },
        count: { $sum: 1 },
        recentSum: { $sum: { $cond: [{ $gte: ["$updatedAt", since] }, "$stars", 0] } },
        recentCount: { $sum: { $cond: [{ $gte: ["$updatedAt", since] }, 1, 0] } }
      }
    }
  ]);
  return new Map(
    rows.map((r) => [
      String(r._id),
      {
        average: Math.round(r.avg * 10) / 10,
        count: r.count,
        recentAverage: r.recentCount ? Math.round((r.recentSum / r.recentCount) * 10) / 10 : null,
        recentCount: r.recentCount
      }
    ])
  );
};

module.exports = { getMine, upsert, getDesignerOwnSummary, getAdminSummaries, isPromptDue };
