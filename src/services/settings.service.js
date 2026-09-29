const Setting = require("../models/Setting");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const { toConfig } = require("../utils/businessHours");

// admin@bonito.in is always told about escalations (D5); admins add more people in settings
const DEFAULT_ESCALATION_EMAIL = (process.env.ESCALATION_DEFAULT_EMAIL || "admin@bonito.in").toLowerCase();
const CACHE_MS = 30 * 1000;
const ESCALATION_ROLES = ["superadmin", "admin", "user"];

let cache = null;
let cachedAt = 0;

const loadSettings = async () => {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const doc = await Setting.findOneAndUpdate(
    { key: "global" },
    { $setOnInsert: { key: "global" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  cache = doc;
  cachedAt = Date.now();
  return doc;
};

const clearCache = () => {
  cache = null;
};

/** Settings plus the ready-to-use working-time config. */
const getSlaSettings = async () => {
  const s = await loadSettings();
  return { settings: s, hours: toConfig(s), sla: s.sla };
};

/** Everyone to tell about an escalation: admin@bonito.in + configured contacts (active staff only). */
const getEscalationRecipients = async () => {
  const s = await loadSettings();
  const users = await User.find({
    $or: [{ email: DEFAULT_ESCALATION_EMAIL }, { _id: { $in: s.escalationContacts || [] } }],
    status: "active",
    role: { $in: ESCALATION_ROLES }
  }).select("_id name email");
  return users;
};

const CONTACT_FIELDS = "name email role designation avatarUrl status";

/** Settings for the admin page, with contacts expanded. */
const getSettingsForAdmin = async () => {
  const s = await Setting.findOne({ key: "global" }).populate("escalationContacts", CONTACT_FIELDS).lean();
  const base = s || (await loadSettings());
  const defaultContact = await User.findOne({ email: DEFAULT_ESCALATION_EMAIL }).select(CONTACT_FIELDS).lean();
  return { ...base, defaultEscalationContact: defaultContact || { email: DEFAULT_ESCALATION_EMAIL, missing: true } };
};

/** Saves a validated settings update (see settings.validator). */
const updateSettings = async (patch, actorId) => {
  const update = { updatedBy: actorId };
  if (patch.businessHours) update.businessHours = { ...patch.businessHours, utcOffsetMinutes: 330 };
  if (patch.holidays) update.holidays = patch.holidays;
  if (patch.sla) update.sla = patch.sla;
  if (patch.moderation) update.moderation = patch.moderation;
  if (patch.payments) {
    const current = (await loadSettings()).payments || {};
    const payee = ["upiId", "accountName", "accountNumber", "ifsc", "bankName"];
    const changed = payee.some((k) => (current[k] || "") !== (patch.payments[k] || ""));
    update.payments = { ...patch.payments, payeeChangedAt: changed ? new Date() : current.payeeChangedAt || null };
  }
  if (patch.referrals) update.referrals = patch.referrals;

  if (patch.escalationContacts) {
    const ids = [...new Set(patch.escalationContacts)];
    const users = await User.find({ _id: { $in: ids } }).select("role status email");
    if (users.length !== ids.length || users.some((u) => !ESCALATION_ROLES.includes(u.role) || u.status !== "active")) {
      throw new ApiError(400, "Escalation contacts must be active Bonito staff accounts");
    }
    update.escalationContacts = users.filter((u) => u.email !== DEFAULT_ESCALATION_EMAIL).map((u) => u._id);
  }

  await Setting.findOneAndUpdate({ key: "global" }, { $set: update }, { upsert: true, runValidators: true, setDefaultsOnInsert: true });
  clearCache();
  return getSettingsForAdmin();
};

module.exports = { getSlaSettings, getEscalationRecipients, getSettingsForAdmin, updateSettings, clearCache, DEFAULT_ESCALATION_EMAIL };
