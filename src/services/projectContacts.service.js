const Conversation = require("../models/Conversation");
const Setting = require("../models/Setting");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { STAFF_ROLES, ADMIN_ROLES } = require("../config/roles");
const { MAX_CONTACTS } = require("../models/subschemas/projectContact");
const { loadSettings, clearCache } = require("./settings.service");

/**
 * Project contacts (project-contacts-plan.md): who a customer should talk to
 * about what. Three layers, each replacing the one before topic by topic:
 *
 *   1. built in   — design → lead designer, site → project manager (chat only,
 *                   no phone or email: nothing personal is shown by default, P3)
 *   2. company    — Setting.projectContacts (P2)
 *   3. project    — conversation.project.contacts
 *
 * Merging is one pass over a Map keyed by topic (O(layers × ≤ 8)). Everyone
 * named is checked against active staff in ONE query; someone who has left or
 * been suspended is skipped, so the layer below shows instead.
 */

const TOPIC_ORDER = { design: 0, site: 1, payments: 2, general: 3, custom: 4 };
const TOPIC_LABEL = {
  design: "Design questions",
  site: "Site & installation",
  payments: "Payments & billing",
  general: "General & escalation",
  custom: ""
};

const sid = (v) => (v ? String(v._id || v) : null);
/** One contact per topic; custom topics are told apart by their label. */
const contactKey = (c) => (c.topic === "custom" ? `custom:${String(c.label || "").trim().toLowerCase()}` : c.topic);

const builtIn = (project) =>
  [
    project?.leadDesigner && { topic: "design", user: project.leadDesigner },
    project?.manager && { topic: "site", user: project.manager }
  ].filter(Boolean);

/**
 * Pure merge (tested directly).
 * @param {{ builtIn: object[], company: object[], project: object[] }} layers
 * @param {Map<string, object>} people  active staff by id
 * @param {Set<string>} memberIds       the chat's members ("Ask in chat" needs membership)
 */
const mergeContacts = (layers, people, memberIds = new Set()) => {
  const byKey = new Map();
  for (const [source, list] of [["team", layers.builtIn], ["company", layers.company], ["project", layers.project]]) {
    for (const c of list || []) {
      const person = people.get(sid(c.user));
      if (person) byKey.set(contactKey(c), { ...c, source, person });
    }
  }
  return [...byKey.entries()]
    .map(([key, c]) => ({
      key,
      topic: c.topic,
      label: c.label?.trim() || TOPIC_LABEL[c.topic],
      source: c.source,
      person: c.person,
      phone: c.phone || "",
      whatsapp: Boolean(c.phone && c.whatsapp),
      email: c.email || "",
      hours: c.hours || "",
      inChat: memberIds.has(String(c.person._id))
    }))
    .sort((a, b) => TOPIC_ORDER[a.topic] - TOPIC_ORDER[b.topic] || a.label.localeCompare(b.label));
};

const PERSON_FIELDS = "name avatarUrl designation availability";

/** Active staff among `ids`, by id: one query for any number of contacts/projects. */
const activePeople = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique }, role: { $in: STAFF_ROLES }, status: "active", deletedAt: null }).select(PERSON_FIELDS).lean();
  return new Map(
    users.map((u) => [
      String(u._id),
      {
        _id: String(u._id),
        name: u.name,
        avatarUrl: u.avatarUrl || "",
        designation: u.designation || "",
        onLeave: u.availability?.status === "on_leave" && (!u.availability.until || new Date(u.availability.until) > new Date())
      }
    ])
  );
};

const layersOf = (project, company) => ({ builtIn: builtIn(project), company, project: project?.contacts || [] });
const idsOf = (l) => [...l.builtIn, ...l.company, ...l.project].map((c) => sid(c.user));

/** Resolved contacts for several projects (customer Home): one settings read + one people query. */
const contactsForMany = async (convs) => {
  const company = (await loadSettings()).projectContacts || [];
  const layers = convs.map((c) => layersOf(c.project, company));
  const people = await activePeople(layers.flatMap(idsOf));
  return new Map(convs.map((c, i) => [String(c._id), mergeContacts(layers[i], people, new Set((c.members || []).map((m) => sid(m.user))))]));
};

const isAdmin = (user) => ADMIN_ROLES.includes(user.role);
const canEdit = (project, user) => isAdmin(user) || (project?.manager && sid(project.manager) === String(user._id));

const loadProject = async (conversationId) => {
  const conv = await Conversation.findOne({ _id: conversationId, project: { $exists: true } }).select("name members project.leadDesigner project.manager project.contacts project.contactsRev").lean();
  if (!conv) throw new ApiError(404, "Project not found");
  return conv;
};

/** GET /projects/:id/contacts — chat members (customers included) and admins. */
const getProjectContacts = async (conversationId, viewer) => {
  const conv = await loadProject(conversationId);
  const member = conv.members.some((m) => sid(m.user) === String(viewer._id));
  if (!member && !isAdmin(viewer)) throw new ApiError(403, "You are not a member of this project");
  const layers = layersOf(conv.project, (await loadSettings()).projectContacts || []);
  const people = await activePeople(idsOf(layers)); // one query serves both lists below
  const contacts = mergeContacts(layers, people, new Set(conv.members.map((m) => sid(m.user))));
  if (!canEdit(conv.project, viewer)) return { contacts };
  return {
    contacts,
    // The project's own list and its revision, only for people who may edit it
    editable: {
      contacts: layers.project.map((c) => ({ ...c, user: String(c.user), person: people.get(String(c.user)) || null })),
      rev: conv.project.contactsRev || 0
    }
  };
};

/**
 * Checks a new list: one contact per topic (custom: per label), and everyone
 * named is active staff of this organisation (one query).
 */
const checkList = async (contacts) => {
  if (contacts.length > MAX_CONTACTS) throw new ApiError(400, `Up to ${MAX_CONTACTS} contacts`);
  const keys = new Set();
  for (const c of contacts) {
    const k = contactKey(c);
    if (keys.has(k)) throw new ApiError(400, c.topic === "custom" ? `"${c.label}" is listed twice` : `${TOPIC_LABEL[c.topic]} is listed twice`);
    keys.add(k);
  }
  const people = await activePeople(contacts.map((c) => c.user));
  const missing = contacts.find((c) => !people.has(String(c.user)));
  if (missing) throw new ApiError(400, "Contacts must be active staff members");
};

const conflict = () => new ApiError(409, "Someone else just changed these contacts. Reload to see their changes.", [{ code: "CONTACTS_CHANGED" }]);
/** Matches the stored revision (documents from before this feature have none: revision 0). */
const revFilter = (field, rev) => (rev === 0 ? { [field]: { $in: [0, null] } } : { [field]: rev });

const notifyMembers = (conv) => {
  try {
    const io = require("../sockets").getIO();
    if (!io) return;
    for (const m of conv.members) io.to(`user:${sid(m.user)}`).emit("chat:project:contacts", { conversationId: String(conv._id) });
  } catch (err) {
    logger.warn(`Contacts socket event skipped: ${err.message}`);
  }
};

/** PUT /projects/:id/contacts — admins and the project's manager (P1). */
const setProjectContacts = async ({ conversationId, actor, contacts, rev }) => {
  const conv = await loadProject(conversationId);
  if (!canEdit(conv.project, actor)) throw new ApiError(403, "Only admins and the project manager can change contacts");
  await checkList(contacts);
  const res = await Conversation.updateOne(
    { _id: conv._id, ...revFilter("project.contactsRev", rev) },
    { $set: { "project.contacts": contacts, "project.contactsRev": rev + 1 } }
  );
  if (!res.matchedCount) throw conflict();
  notifyMembers(conv);
  return getProjectContacts(conversationId, actor);
};

// ── Company defaults (admins) ─────────────────────────────────────────────────

const getCompanyContacts = async () => {
  const s = await loadSettings();
  const list = s.projectContacts || [];
  const people = await activePeople(list.map((c) => c.user));
  return {
    contacts: list.map((c) => ({ ...c, user: String(c.user), person: people.get(String(c.user)) || null })), // person null: left / suspended
    rev: s.projectContactsRev || 0
  };
};

const setCompanyContacts = async ({ actor, contacts, rev }) => {
  await checkList(contacts);
  await loadSettings(); // makes sure the settings document exists
  const res = await Setting.updateOne(
    { key: "global", ...revFilter("projectContactsRev", rev) },
    { $set: { projectContacts: contacts, projectContactsRev: rev + 1, updatedBy: actor._id } }
  );
  if (!res.matchedCount) throw conflict();
  clearCache();
  return getCompanyContacts();
};

/**
 * Staff to pick from, with the profile phone and email to prefill (P3). Only
 * people who may edit contacts reach this (route + `canEditAny`).
 */
const escapeRegex = (s) => String(s).slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const candidates = async (search = "") => {
  const q = { role: { $in: STAFF_ROLES }, status: "active", deletedAt: null };
  if (search.trim()) q.name = new RegExp(escapeRegex(search.trim()), "i");
  const users = await User.find(q).sort({ name: 1 }).limit(20).select("name designation avatarUrl email phone").lean();
  return users.map((u) => ({ _id: String(u._id), name: u.name, designation: u.designation || "", avatarUrl: u.avatarUrl || "", email: u.email || "", phone: u.phone || "" }));
};

/** Candidates for one project's editor: admins or that project's manager. */
const projectCandidates = async (conversationId, actor, search) => {
  const conv = await loadProject(conversationId);
  if (!canEdit(conv.project, actor)) throw new ApiError(403, "Only admins and the project manager can change contacts");
  return candidates(search);
};

module.exports = {
  getProjectContacts,
  setProjectContacts,
  getCompanyContacts,
  setCompanyContacts,
  contactsForMany,
  candidates,
  projectCandidates,
  _internals: { mergeContacts, contactKey, builtIn, revFilter, TOPIC_LABEL }
};
