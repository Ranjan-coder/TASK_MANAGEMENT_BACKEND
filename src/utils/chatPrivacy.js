/**
 * What a customer may see of a chat (chat-features-plan.md CH-R, decision CH-D3,
 * security review 2026-10-24).
 *
 * Staff get the conversation as stored. A customer gets an ALLOW-LISTED copy:
 *  - read state: only that *the team* saw or got a message (teamLastRead /
 *    teamLastDelivered, the latest of anyone else), never anyone's own times
 *  - project: status, current stage, expected handover and who's on the team
 *    (ids, names, avatars). Never the internal workflow (flow, step keys,
 *    checklists, ticks), the stage history with staff notes, or other
 *    customers' contact details. Their timeline comes from /projects/mine,
 *    which already filters it for customers.
 *  - moderation: only what drives the chat-wide warning (when, and whether one
 *    is open), not the incident id
 *  - keys: only their own wrapped copies
 *  - no team-notes link, no rekey flag
 * Fields added to conversations later stay hidden from customers until listed here.
 */
const idOf = (v) => (v ? String(v._id || v) : null);

const customerIds = (conv) => new Set((conv?.project?.customers || []).map(idOf).filter(Boolean));

/** True when this viewer is a customer of this project chat. */
const isProjectCustomer = (conv, viewerId) => Boolean(conv?.project) && customerIds(conv).has(String(viewerId));

const latest = (dates) => {
  let max = null;
  for (const d of dates) if (d && (!max || new Date(d) > max)) max = new Date(d);
  return max;
};

const TOP_LEVEL = ["_id", "type", "name", "avatarUrl", "createdBy", "lastMessage", "lastActivityAt", "isArchived", "createdAt", "updatedAt", "orgId", "pins"];
// Fields some responses add on top of the stored document (unread counts, presence, my settings)
const COMPUTED = ["unreadCount", "mentionCount", "notify", "mutedUntil"];

/** A team member as a customer sees them: id, name, avatar (never email or phone). */
const person = (u) => {
  if (!u) return null;
  if (typeof u === "object" && u._id) return { _id: String(u._id), name: u.name, avatarUrl: u.avatarUrl };
  return String(u);
};

/** Only this viewer's entries of a key map (Mongoose Map or plain object). */
const ownEntries = (keys, viewerId) => {
  if (!keys) return {};
  const get = (k) => (keys instanceof Map ? keys.get(k) : keys[k]);
  const mine = get(String(viewerId));
  return mine ? { [String(viewerId)]: mine } : {};
};

const customerView = (o, viewerId) => {
  const out = {};
  for (const k of [...TOP_LEVEL, ...COMPUTED]) if (o[k] !== undefined) out[k] = o[k];

  const others = (o.members || []).filter((m) => m?.user && idOf(m.user) !== String(viewerId));
  out.teamLastRead = latest(others.map((m) => m.lastRead));
  out.teamLastDelivered = latest(others.map((m) => m.lastDelivered || m.lastRead));
  out.members = (o.members || []).map((m) => {
    if (!m) return m;
    const base = { user: m.user, role: m.role, joinedAt: m.joinedAt, isOnline: m.isOnline };
    // Their own times stay (their own unread state)
    return idOf(m.user) === String(viewerId) ? { ...base, lastRead: m.lastRead, lastDelivered: m.lastDelivered } : base;
  });

  if (o.project) {
    const p = o.project;
    out.project = {
      status: p.status,
      stage: p.stage,
      expectedHandover: p.expectedHandover ?? null,
      createdAt: p.createdAt,
      customers: (p.customers || []).map(idOf).filter(Boolean),
      leadDesigner: person(p.leadDesigner),
      backupDesigner: person(p.backupDesigner),
      manager: person(p.manager)
    };
  }
  if (o.moderation) {
    out.moderation = { warningAt: o.moderation.warningAt || null, openIncident: o.moderation.openIncident ? true : null };
  }
  if (o.groupKeys) out.groupKeys = ownEntries(o.groupKeys, viewerId);
  if (Array.isArray(o.groupKeyring)) {
    out.groupKeyring = o.groupKeyring.map((r) => ({ version: r.version, createdAt: r.createdAt, keys: ownEntries(r.keys, viewerId) }));
  }
  return out;
};

/**
 * The conversation as this viewer should receive it. `viewerRole` (when the
 * caller knows it) makes the customer view apply in any group, not only in
 * project chats where they're listed as a customer.
 */
const forViewer = (conv, viewerId, viewerRole) => {
  if (!conv) return conv;
  const o = typeof conv.toJSON === "function" ? conv.toJSON() : { ...conv };
  const asCustomer = viewerRole === "customer" || isProjectCustomer(o, viewerId);
  return asCustomer ? customerView(o, viewerId) : o;
};

module.exports = { forViewer, isProjectCustomer, customerIds };
