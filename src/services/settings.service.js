const Setting = require("../models/Setting");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const { toConfig } = require("../utils/businessHours");
const { createOrgCache } = require("../utils/orgCache");

// The organisation's first superadmin is always told about escalations (D5);
// admins add more people in settings
const ESCALATION_ROLES = ["superadmin", "admin", "user"];

// One settings document per organisation, cached per organisation (30 s)
const cache = createOrgCache({ ttlMs: 30 * 1000 });

const loadSettings = () =>
  cache.get(() =>
    Setting.findOneAndUpdate(
      { key: "global" },
      { $setOnInsert: { key: "global" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean()
  );

const clearCache = () => cache.invalidate();

/** The default escalation contact: this organisation's longest-standing active superadmin. */
const findDefaultContact = (select = "_id") =>
  User.findOne({ role: "superadmin", status: "active" }).sort({ createdAt: 1 }).select(select);

/** Settings plus the ready-to-use working-time config. */
const getSlaSettings = async () => {
  const s = await loadSettings();
  return { settings: s, hours: toConfig(s), sla: s.sla };
};

/** Everyone to tell about an escalation: the default contact + configured contacts (active staff only). */
const getEscalationRecipients = async () => {
  const [s, primary] = await Promise.all([loadSettings(), findDefaultContact()]);
  const ids = [...(s.escalationContacts || []), ...(primary ? [primary._id] : [])];
  const users = await User.find({
    _id: { $in: ids },
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
  const defaultContact = await findDefaultContact(CONTACT_FIELDS).lean();
  return { ...base, defaultEscalationContact: defaultContact || { email: "", missing: true } };
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
      throw new ApiError(400, "Escalation contacts must be active staff accounts");
    }
    const primary = await findDefaultContact();
    update.escalationContacts = users.filter((u) => !primary || String(u._id) !== String(primary._id)).map((u) => u._id);
  }

  await Setting.findOneAndUpdate({ key: "global" }, { $set: update }, { upsert: true, runValidators: true, setDefaultsOnInsert: true });
  clearCache();
  return getSettingsForAdmin();
};

module.exports = { getSlaSettings, getEscalationRecipients, getSettingsForAdmin, updateSettings, clearCache, loadSettings };
