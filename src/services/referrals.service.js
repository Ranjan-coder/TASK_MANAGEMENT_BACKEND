const crypto = require("crypto");
const User = require("../models/User");
const Referral = require("../models/Referral");
const Lead = require("../models/Lead");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const config = require("../config/env");
const { ROLES } = require("../config/roles");
const { getSlaSettings, getEscalationRecipients } = require("./settings.service");

/**
 * Referrals (R9). Every verified customer gets a code. A friend who signs up
 * with it, verifies their phone and makes a first payment "qualifies"; an
 * admin then gives the reward. Checks stop self-referral and fake accounts.
 */

// No look-alike characters (0/O, 1/I/L)
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_REFERRALS_PER_DAY = 10;
const idStr = (v) => (v ? String(v._id || v) : null);
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "A friend";

const newCode = () => {
  const bytes = crypto.randomBytes(6);
  return `BON-${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("")}`;
};

const normaliseCode = (code) =>
  String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^BON/, "BON-")
    .slice(0, 10);

/** The customer's code, created on first use (only for verified customers). */
const ensureCode = async (user) => {
  if (user.referralCode) return user.referralCode;
  if (user.role !== ROLES.CUSTOMER || !user.phoneVerified) return null;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    try {
      const updated = await User.findOneAndUpdate({ _id: user._id, referralCode: { $exists: false } }, { $set: { referralCode: code } }, { new: true });
      return updated?.referralCode || (await User.findById(user._id).select("referralCode")).referralCode;
    } catch (err) {
      if (err.code !== 11000) throw err; // code taken: try another
    }
  }
  throw new ApiError(500, "Couldn't create a referral code. Please try again.");
};

const programme = async () => {
  const { settings } = await getSlaSettings();
  const r = settings.referrals || {};
  return { enabled: r.enabled !== false, referrerReward: r.referrerReward || "", friendReward: r.friendReward || "", terms: r.terms || "" };
};

const getMine = async (userId) => {
  const user = await User.findById(userId).select("role phoneVerified referralCode name");
  const prog = await programme();
  const code = prog.enabled ? await ensureCode(user) : null;
  const refs = await Referral.find({ referrer: userId }).sort({ createdAt: -1 }).limit(100).populate("referred", "name").lean();
  return {
    ...prog,
    code,
    link: code ? `${config.clientUrl}/signup?ref=${encodeURIComponent(code)}` : null,
    needsVerification: !user.phoneVerified,
    // Friends are shown by first name only
    referrals: refs.map((r) => ({ _id: r._id, friend: firstName(r.referred?.name), status: r.status, createdAt: r.createdAt, rewardedAt: r.rewardedAt })),
    counts: {
      joined: refs.length,
      qualified: refs.filter((r) => ["qualified", "rewarded"].includes(r.status)).length,
      rewarded: refs.filter((r) => r.status === "rewarded").length
    }
  };
};

/** Public check on the signup page: is this code valid? (no personal data) */
const checkCode = async (code) => {
  const prog = await programme();
  if (!prog.enabled) return { valid: false };
  const owner = await User.findOne({ referralCode: normaliseCode(code), role: ROLES.CUSTOMER, status: "active" }).select("name");
  return owner ? { valid: true, referrerFirstName: firstName(owner.name), friendReward: prog.friendReward } : { valid: false };
};

/** Called after a new customer signs up with a code. Never blocks signup. */
const recordSignup = async ({ referred, code }) => {
  try {
    if (!code) return null;
    const prog = await programme();
    if (!prog.enabled) return null;
    const referrer = await User.findOne({ referralCode: normaliseCode(code), role: ROLES.CUSTOMER, status: "active" }).select("_id name email phone");
    if (!referrer || String(referrer._id) === String(referred._id)) return null;
    // Same person with a second account
    const samePhone = referrer.phone && [referred.phone, referred.pendingPhone].includes(referrer.phone);
    if (samePhone || referrer.email === referred.email) return null;
    const today = await Referral.countDocuments({ referrer: referrer._id, createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } });
    if (today >= MAX_REFERRALS_PER_DAY) {
      logger.warn(`Referral limit reached for ${referrer._id}`);
      return null;
    }
    const ref = await Referral.create({ referrer: referrer._id, referred: referred._id, code: normaliseCode(code) });
    // Marketing follows the friend up like any consultation request
    await Lead.create({ customer: referred._id, campaign: null, message: `Referred by ${referrer.name}` }).catch(() => {});
    return ref;
  } catch (err) {
    if (err.code !== 11000) logger.warn(`Referral not recorded: ${err.message}`);
    return null;
  }
};

/** When a referred customer's first payment is confirmed, the referral qualifies. */
const onFirstPayment = async (customerIds, projectCustomerIds = customerIds) => {
  const onProject = new Set(projectCustomerIds.map(idStr));
  for (const id of customerIds.map(idStr)) {
    const friend = await User.findById(id).select("name phoneVerified status");
    if (!friend?.phoneVerified || friend.status !== "active") continue;
    const pending = await Referral.findOne({ referred: id, status: "signed_up" }).select("referrer");
    // The referrer paying for a project their "friend" was added to doesn't count
    if (!pending || onProject.has(idStr(pending.referrer))) continue;
    const ref = await Referral.findOneAndUpdate({ _id: pending._id, status: "signed_up" }, { $set: { status: "qualified", qualifiedAt: new Date() } }, { new: true });
    if (!ref) continue;
    const { sendNotification } = require("./notification.service");
    await sendNotification({
      recipient: ref.referrer,
      type: "project_update",
      title: "Your referral qualified 🎉",
      message: `${firstName(friend.name)} started their project with Bonito. We'll confirm your reward soon.`
    }).catch(() => {});
    for (const a of await getEscalationRecipients()) {
      sendNotification({ recipient: a._id, type: "project_update", title: "Referral reward to approve", message: "A referred customer made their first payment. Review it in Admin → Referrals." }).catch(() => {});
    }
  }
};

// ── Admin ────────────────────────────────────────────────────────────────────

const adminList = async ({ status }) => {
  const rows = await Referral.find(status ? { status } : {})
    .sort({ createdAt: -1 })
    .limit(300)
    .populate("referrer", "name email phone")
    .populate("referred", "name email phone phoneVerified status createdAt")
    .populate("handledBy", "name")
    .lean();
  const counts = await Referral.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
  return { rows, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])), programme: await programme() };
};

const adminAct = async ({ id, admin, action, note = "" }) => {
  const from = action === "reward" ? ["qualified"] : ["signed_up", "qualified"];
  const ref = await Referral.findOneAndUpdate(
    { _id: id, status: { $in: from } },
    { $set: { status: action === "reward" ? "rewarded" : "rejected", handledBy: admin._id, note, ...(action === "reward" && { rewardedAt: new Date() }) } },
    { new: true }
  );
  if (!ref) throw new ApiError(409, action === "reward" ? "Only qualified referrals can be rewarded" : "This referral is already closed");
  if (action === "reward") {
    const prog = await programme();
    const { sendNotification } = require("./notification.service");
    await sendNotification({
      recipient: ref.referrer,
      type: "project_update",
      title: "Referral reward confirmed",
      message: `${prog.referrerReward}${note ? ` — ${note}` : ""}`.slice(0, 300)
    }).catch(() => {});
  }
  return ref;
};

module.exports = { normaliseCode, ensureCode, getMine, checkCode, recordSignup, onFirstPayment, adminList, adminAct };
