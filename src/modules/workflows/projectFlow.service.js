const Conversation = require("../../models/Conversation");
const ApiError = require("../../utils/ApiError");
const nav = require("./engine/navigate");
const workflows = require("./workflow.service");

/**
 * A project moving through its workflow version (project-workflow-plan.md §7).
 *
 * Every change is ONE conditional update on what the person saw (the step, the
 * version, the item): two people acting at once can't both apply, the second gets
 * 409 and the current state. The rules live in engine/navigate.js (pure); this
 * file loads the project, checks who may act, writes, and tells people.
 *
 * Customers are members of the chat room, so live updates go person by person:
 * staff get the full view, customers only the customer view (no internal names,
 * hidden steps, handlers or gates).
 */

const HISTORY_CAP = 500; // newest entries kept per project
const DAY = 24 * 60 * 60 * 1000;
const MIN_REASON = nav.MIN_REASON;

const helpers = () => require("../../services/projectExtras.service")._helpers;
const orgLists = () => require("../../services/org.service").load();

const fail = (status, code, message, extra = {}) => new ApiError(status, message, [{ code, ...extra }]);
const asApiError = (err) => (err instanceof nav.FlowError ? fail(err.status, err.code, err.message, err.details ? { blockers: err.details } : {}) : err);
const sid = (v) => (v ? String(v._id || v) : null);

// ── Loading ───────────────────────────────────────────────────────────────────

const load = async (conversationId) => {
  const conv = await Conversation.findById(conversationId).select("name members project").lean();
  if (!conv?.project) throw new ApiError(404, "Project not found");
  return conv;
};

/** Engine state from the stored project (older projects: their stage on version 1). */
const stateOf = (project, c, gateFacts = {}) => {
  const f = project.flow;
  return {
    stepKey: f ? f.stepKey : c.steps[nav.positionOf(c, project.stage)].key,
    status: project.status,
    activated: new Set((f?.activated || []).map((a) => a.key)),
    ticks: f?.ticks || {},
    extras: (f?.extras || []).map((x) => ({ ...x, _id: String(x._id) })),
    checks: new Set(f?.checks || []),
    gateFacts
  };
};

const at = (c, state) => nav.positionOf(c, state.stepKey);
const stageAt = (c, state) => c.stages[c.steps[at(c, state)].stageIdx];

/** When a stage should be done (E1): its own duration, or the sum of its running sub-stages'. */
const stageDueAt = (stage, activated, start) => {
  let days = stage.durationDays;
  if (!days) {
    const live = stage.subs.filter((s) => !s.optional || activated.has(s.path));
    const sum = live.reduce((n, s) => n + (s.durationDays || 0), 0);
    days = sum || null;
  }
  return days ? new Date(start.getTime() + days * DAY) : null;
};

/** A first `flow` for projects created before workflows existed (set in the same write). */
const initialFlow = (c, project, stepKey, now) => ({
  versionId: c.versionId,
  version: c.version,
  stepKey,
  ticks: {},
  activated: [],
  extras: [],
  checks: [],
  enteredAt: now,
  stageEnteredAt: project.flow?.stageEnteredAt || now,
  dueAt: null,
  overdueNotifiedAt: null
});

/** Write filter "still as this person saw it": by step for workflow projects, by stage for older ones. */
const sameAsSeen = (conv, c, stepKey) =>
  conv.project.flow
    ? { _id: conv._id, "project.flow.versionId": conv.project.flow.versionId, "project.flow.stepKey": stepKey }
    : { _id: conv._id, "project.flow": { $exists: false }, "project.stage": conv.project.stage === "consultation" || !conv.project.stage ? { $in: [conv.project.stage || "consultation", null] } : conv.project.stage };

// ── Who may act ───────────────────────────────────────────────────────────────

/**
 * "admin" | "team" | "handler" | null for this stage (W3). Handlers: people named
 * on the stage, and the head of the stage's department (looked up in the cached
 * department list, O(1)).
 */
const roleFor = async (actor, conv, stage) => {
  const h = helpers();
  if (h.ADMIN_ROLES.includes(actor.role)) return "admin";
  if (actor.role === "customer") return null;
  const me = String(actor._id);
  if (h.isTeamLead(conv, me) && h.isMember(conv, me)) return "team";
  if (stage?.handlerSet?.has(me)) return "handler";
  if (stage?.departmentId) {
    const head = (await orgLists()).deptById.get(String(stage.departmentId))?.head;
    if (head && String(head) === me) return "handler";
  }
  return null;
};

const requireRole = async (actor, conv, ...stagesToCheck) => {
  for (const s of stagesToCheck) {
    const role = await roleFor(actor, conv, s);
    if (role) return role;
  }
  throw fail(403, "NOT_STAGE_HANDLER", "Only the project team, the people handling this stage or an admin can do this");
};

// ── Gate facts (E3), looked up only for stages that have those gates ──────────

const gateFactsFor = async (conv, stage) => {
  const g = stage.gates || {};
  if (!g.approval && !g.payment) return {};
  const since = conv.project.flow?.stageEnteredAt || new Date(0);
  const facts = {};
  if (g.approval) {
    const DesignApproval = require("../../models/DesignApproval");
    facts.approval = Boolean(await DesignApproval.exists({ conversation: conv._id, status: "approved", decidedAt: { $gte: since } }));
  }
  if (g.payment) {
    const ProjectFinance = require("../../models/ProjectFinance");
    const fin = await ProjectFinance.findOne({ conversation: conv._id }).select("milestones.stageKey milestones.status").lean();
    const linked = (fin?.milestones || []).filter((m) => m.stageKey === stage.key);
    facts.payment = linked.length > 0 && linked.every((m) => m.status === "paid" || m.status === "waived");
  }
  return { [stage.key]: facts };
};

// ── Telling people ────────────────────────────────────────────────────────────

const staffMembers = (conv) => conv.members.filter((m) => !conv.project.customers.some((c) => sid(c) === sid(m.user))).map((m) => sid(m.user));

/** Live update, person by person (customers get the customer view only). */
const broadcast = (conv, c, project) => {
  const state = stateOf(project, c);
  const staff = { conversationId: String(conv._id), status: project.status, stage: project.stage, version: c.version, flow: nav.staffView(c, state) };
  const customer = { conversationId: String(conv._id), status: project.status, stage: project.stage, flow: nav.customerView(c, state) };
  helpers().emit((io) => {
    for (const u of staffMembers(conv)) io.to(`user:${u}`).emit("chat:project:stage", staff);
    for (const u of conv.project.customers) io.to(`user:${sid(u)}`).emit("chat:project:stage", customer);
  });
  return staff;
};

const tellCustomer = async (conv, actorId, { notice, title, message }) => {
  const h = helpers();
  if (notice) await h.postNotice(conv._id, actorId, notice);
  if (title) await h.notify(conv.project.customers, { title, message: message || `"${conv.name}"`, relatedConversation: conv._id });
};

/** A step the customer can see: a stage change, a shown sub-stage, or one activated for them. */
const visibleToCustomer = (c, stepKey, activated) => {
  const step = c.steps[c.stepIndex.get(stepKey)];
  if (!step?.subKey) return true;
  const sub = c.subPath.get(stepKey)?.sub;
  return Boolean(sub && (sub.showToCustomer || (sub.optional && activated.has(stepKey))));
};

// ── Moving ────────────────────────────────────────────────────────────────────

/**
 * Moves the project to `to` (a step key). `from` = the step on screen.
 * Leaving a stage forwards needs its sub-stages, extra work and gates done; an
 * admin may override with a reason (recorded).
 */
const move = async ({ conversationId, actor, to, from, note = "", override = false }) => {
  const conv = await load(conversationId);
  const c = await workflows.compiledForProject(conv.project);
  const state0 = stateOf(conv.project, c);
  const curKey = c.steps[at(c, state0)].key;
  if (from && from !== curKey) throw fail(409, "STEP_CHANGED", "Someone just moved this project. Check and try again.", { step: curKey });

  const curStage = stageAt(c, state0);
  const target = c.stepIndex.has(to) ? c.stages[c.steps[c.stepIndex.get(to)].stageIdx] : null;
  const role = await requireRole(actor, conv, curStage, target);
  const isAdmin = role === "admin";

  let plan;
  try {
    plan = nav.planMove(c, { ...state0, gateFacts: await gateFactsFor(conv, curStage) }, to, { isAdmin, note, override });
  } catch (err) {
    throw asApiError(err);
  }
  if (plan.kind === "same") throw fail(400, "NOTHING_TO_DO", "The project is already at that step");

  const now = new Date();
  const toStep = c.steps[plan.to];
  const toStage = c.stages[toStep.stageIdx];
  const $set = { "project.stage": toStage.key };
  if (conv.project.flow) {
    Object.assign($set, { "project.flow.stepKey": toStep.key, "project.flow.enteredAt": now });
    if (plan.crossesStage) {
      Object.assign($set, {
        "project.flow.stageEnteredAt": now,
        "project.flow.dueAt": stageDueAt(toStage, state0.activated, now),
        "project.flow.overdueNotifiedAt": null
      });
    }
  } else {
    $set["project.flow"] = { ...initialFlow(c, conv.project, toStep.key, now), stageEnteredAt: now, dueAt: stageDueAt(toStage, state0.activated, now) };
  }
  const entry = {
    stage: toStage.key,
    step: toStep.key,
    version: c.version,
    from: curKey,
    kind: plan.kind,
    at: now,
    by: actor._id,
    note: `${String(note || "").trim()}${plan.overridden ? " (moved on without finishing: admin)" : ""}`.slice(0, 300)
  };
  const updated = await Conversation.findOneAndUpdate(
    sameAsSeen(conv, c, curKey),
    { $set, $push: { "project.stageHistory": { $each: [entry], $slice: -HISTORY_CAP } } },
    { new: true, projection: { name: 1, project: 1 } }
  ).lean();
  if (!updated) throw fail(409, "STEP_CHANGED", "Someone just moved this project. Check and try again.");

  // Customers hear about stage changes and steps they can see; internal steps stay internal
  const trimmed = String(note || "").trim();
  if (plan.crossesStage) {
    const verb = plan.kind === "back" ? "moved back to" : "is now at";
    const intro = toStage.entryMessage ? `\n${toStage.entryMessage}` : ""; // E5
    await tellCustomer(conv, actor._id, {
      notice: `📍 Project stage: ${toStage.customerName}${trimmed ? ` — ${trimmed}` : ""}${intro}`,
      title: `Your project ${verb}: ${toStage.customerName}`,
      message: `"${conv.name}"${trimmed ? ` — ${trimmed}` : ""}${toStage.entryMessage ? ` · ${toStage.entryMessage}` : ""}`
    });
    await require("./stageHooks").stageEntered({ conv, c, stage: toStage, actor, at: now }); // E4
  } else if (visibleToCustomer(c, toStep.key, state0.activated)) {
    const sub = c.subPath.get(toStep.key)?.sub;
    await tellCustomer(conv, actor._id, { notice: `📍 ${toStage.customerName}: ${sub?.customerName}${trimmed ? ` — ${trimmed}` : ""}` });
  }
  return { ...broadcast(conv, c, updated.project), move: plan.kind, from: curKey, overridden: plan.overridden };
};

/** Old "set stage" calls (stage keys): mapped to that stage's first running step. */
const moveToStage = async ({ conversationId, actor, stage, from, note, override }) => {
  const conv = await load(conversationId);
  const c = await workflows.compiledForProject(conv.project);
  const state = stateOf(conv.project, c);
  const si = c.stageIndex.get(stage);
  if (si === undefined) throw fail(400, "STEP_UNKNOWN", "That stage isn't in this project's workflow");
  const cur = stageAt(c, state);
  if (from && from !== cur.key) throw fail(409, "STAGE_CHANGED", "Someone just moved this project. Check and try again.", { stage: cur.key });
  if (stage === cur.key) throw fail(400, "NOTHING_TO_DO", "The project is already at that stage");
  const s = c.stages[si];
  let j = s.firstStep;
  while (j <= s.lastStep && !nav.isLive(c, j, state.activated)) j += 1;
  return move({ conversationId, actor, to: c.steps[j].key, from: c.steps[at(c, state)].key, note, override });
};

// ── Small changes inside a stage (all one conditional write) ──────────────────

/** Makes sure the project has a stored flow before an in-stage change (older projects). */
const withFlow = async (conversationId) => {
  let conv = await load(conversationId);
  const c = await workflows.compiledForProject(conv.project);
  if (!conv.project.flow) {
    const now = new Date();
    const stepKey = c.steps[nav.positionOf(c, conv.project.stage)].key;
    await Conversation.updateOne(sameAsSeen(conv, c, stepKey), { $set: { "project.flow": initialFlow(c, conv.project, stepKey, now) } });
    conv = await load(conversationId);
  }
  return { conv, c };
};

/**
 * Adds the history entry to an update. Merges into an existing $push (spreading two
 * objects with a $push each would silently drop the first one).
 */
const withHistory = (update, { conv, c, kind, note, actor, step = null }) => {
  const entry = { stage: conv.project.stage, step: step || conv.project.flow.stepKey, version: c.version, from: null, kind, at: new Date(), by: actor._id, note: String(note || "").slice(0, 300) };
  return { ...update, $push: { ...(update.$push || {}), "project.stageHistory": { $each: [entry], $slice: -HISTORY_CAP } } };
};

const apply = async (filter, update) => {
  const updated = await Conversation.findOneAndUpdate(filter, update, { new: true, projection: { name: 1, project: 1 } }).lean();
  if (!updated) throw fail(409, "PROJECT_CHANGED", "This project just changed. Check and try again.");
  return updated;
};

const activeOnly = (conv) => {
  if (conv.project.status !== "active") throw fail(409, conv.project.status === "completed" ? "PROJECT_COMPLETED" : "PROJECT_ON_HOLD", "This project isn't active right now.");
};

/**
 * Switch on an optional sub-stage for this project (W5), e.g. "Redesign". It joins
 * the project's path and this customer sees it from now on.
 */
const activate = async ({ conversationId, actor, path, note = "" }) => {
  const { conv, c } = await withFlow(conversationId);
  activeOnly(conv);
  const hit = c.subPath.get(path);
  if (!hit || !hit.sub.optional) throw fail(400, "NOT_OPTIONAL", "That isn't an optional step of this workflow");
  const stage = c.stages[hit.stageIdx];
  await requireRole(actor, conv, stage);
  if (String(note).trim().length < MIN_REASON) throw fail(400, "STAGE_REASON_REQUIRED", "Say why it's being added (the customer will see it)");
  const state = stateOf(conv.project, c);
  if (state.activated.has(path)) throw fail(409, "ALREADY_ACTIVE", `"${hit.sub.name}" is already part of this project`);
  const pos = at(c, state);
  const curStageIdx = c.steps[pos].stageIdx;
  // Only steps still ahead (in-order: after the current step; any-order: this stage or later)
  const ahead = stage.any ? hit.stageIdx >= curStageIdx : c.stepIndex.get(path) > pos;
  if (!ahead) throw fail(400, "STEP_PASSED", "That step is already behind this project");

  const updated = await apply(
    { _id: conv._id, "project.flow.versionId": conv.project.flow.versionId, "project.flow.activated.key": { $ne: path } },
    withHistory({ $push: { "project.flow.activated": { key: path, at: new Date(), by: actor._id, note: String(note).trim().slice(0, 300) } } }, { conv, c, kind: "activate", note: `${hit.sub.name}: ${note}`, actor, step: path })
  );
  await tellCustomer(conv, actor._id, {
    notice: `➕ Added to your project: ${hit.sub.customerName} (${stage.customerName}) — ${String(note).trim()}`,
    title: `Added to your project: ${hit.sub.customerName}`,
    message: `"${conv.name}" — ${String(note).trim()}`
  });
  return broadcast(conv, c, updated.project);
};

/** Switch an optional sub-stage off again, while it hasn't started. */
const deactivate = async ({ conversationId, actor, path }) => {
  const { conv, c } = await withFlow(conversationId);
  const hit = c.subPath.get(path);
  if (!hit) throw fail(400, "STEP_UNKNOWN", "That step isn't in this project's workflow");
  const stage = c.stages[hit.stageIdx];
  await requireRole(actor, conv, stage);
  const state = stateOf(conv.project, c);
  if (!state.activated.has(path)) throw fail(409, "NOT_ACTIVE", "That step isn't part of this project");
  const pos = at(c, state);
  const started = stage.any ? Number(state.ticks[stage.key] || 0) & hit.sub.bit || hit.stageIdx < c.steps[pos].stageIdx : c.stepIndex.get(path) <= pos;
  if (started) throw fail(409, "STEP_STARTED", "That step has already started, so it can't be removed");
  const updated = await apply(
    { _id: conv._id, "project.flow.versionId": conv.project.flow.versionId, "project.flow.stepKey": conv.project.flow.stepKey, "project.flow.activated.key": path },
    withHistory({ $pull: { "project.flow.activated": { key: path } } }, { conv, c, kind: "deactivate", note: hit.sub.name, actor, step: path })
  );
  await tellCustomer(conv, actor._id, { notice: `➖ Removed from your project: ${hit.sub.customerName}` });
  return broadcast(conv, c, updated.project);
};

/**
 * Tick / untick a sub-stage of the current any-order stage (W4). One atomic $bit
 * on that stage's bitmask: concurrent ticks of different sub-stages never clash.
 */
const tick = async ({ conversationId, actor, path, done = true }) => {
  const { conv, c } = await withFlow(conversationId);
  activeOnly(conv);
  const hit = c.subPath.get(path);
  if (!hit) throw fail(400, "STEP_UNKNOWN", "That step isn't in this project's workflow");
  const stage = c.stages[hit.stageIdx];
  if (!stage.any) throw fail(400, "NOT_A_CHECKLIST", "This stage's steps go in order: use Next instead");
  const state = stateOf(conv.project, c);
  if (stageAt(c, state).key !== stage.key) throw fail(409, "NOT_CURRENT_STAGE", "You can only tick steps in the current stage");
  if (hit.sub.optional && !state.activated.has(path)) throw fail(400, "STEP_NOT_ACTIVE", `"${hit.sub.name}" isn't part of this project. Add it first.`);
  await requireRole(actor, conv, stage);
  const field = `project.flow.ticks.${stage.key}`;
  const updated = await apply(
    { _id: conv._id, "project.flow.versionId": conv.project.flow.versionId, "project.flow.stepKey": conv.project.flow.stepKey },
    withHistory({ $bit: { [field]: done ? { or: hit.sub.bit } : { and: ~hit.sub.bit } } }, { conv, c, kind: done ? "tick" : "untick", note: hit.sub.name, actor, step: path })
  );
  if (done && (hit.sub.showToCustomer || hit.sub.optional)) await tellCustomer(conv, actor._id, { notice: `✔ ${stage.customerName}: ${hit.sub.customerName} done` });
  return broadcast(conv, c, updated.project);
};

/** "Additional work" (C2): a one-off item in this or a later stage; blocks leaving that stage until done. */
const addExtra = async ({ conversationId, actor, stageKey, note = "" }) => {
  const { conv, c } = await withFlow(conversationId);
  activeOnly(conv);
  const si = c.stageIndex.get(stageKey);
  if (si === undefined) throw fail(400, "STEP_UNKNOWN", "That stage isn't in this project's workflow");
  const state = stateOf(conv.project, c);
  if (si < c.steps[at(c, state)].stageIdx) throw fail(400, "STEP_PASSED", "That stage is already behind this project");
  await requireRole(actor, conv, c.stages[si]);
  const text = String(note).trim();
  if (text.length < MIN_REASON) throw fail(400, "STAGE_REASON_REQUIRED", "Describe the additional work (the customer will see it)");
  if ((conv.project.flow.extras || []).filter((x) => !x.done).length >= 20) throw fail(400, "EXTRA_LIMIT", "Finish some additional work before adding more");
  const updated = await apply(
    { _id: conv._id, "project.flow.versionId": conv.project.flow.versionId },
    withHistory({ $push: { "project.flow.extras": { stageKey, note: text.slice(0, 300), done: false, at: new Date(), by: actor._id } } }, { conv, c, kind: "extra", note: text, actor })
  );
  await tellCustomer(conv, actor._id, {
    notice: `➕ Additional work (${c.stages[si].customerName}): ${text}`,
    title: "Additional work added to your project",
    message: `"${conv.name}" — ${text}`
  });
  return broadcast(conv, c, updated.project);
};

/** Mark additional work done (or remove it, if it was added by mistake and isn't done). */
const updateExtra = async ({ conversationId, actor, extraId, action }) => {
  const { conv, c } = await withFlow(conversationId);
  const item = (conv.project.flow.extras || []).find((x) => String(x._id) === String(extraId));
  if (!item) throw fail(404, "NOT_FOUND", "That item isn't on this project");
  await requireRole(actor, conv, c.stages[c.stageIndex.get(item.stageKey)]);
  if (item.done) throw fail(409, "ALREADY_DONE", "That's already done");
  const base = { _id: conv._id, "project.flow.extras": { $elemMatch: { _id: item._id, done: false } } };
  if (action === "remove") {
    const updated = await apply(base, withHistory({ $pull: { "project.flow.extras": { _id: item._id } } }, { conv, c, kind: "extra", note: `Removed: ${item.note}`, actor }));
    await tellCustomer(conv, actor._id, { notice: `➖ Removed: ${item.note}` });
    return broadcast(conv, c, updated.project);
  }
  const updated = await apply(
    base,
    withHistory(
      { $set: { "project.flow.extras.$.done": true, "project.flow.extras.$.doneAt": new Date(), "project.flow.extras.$.doneBy": actor._id } },
      { conv, c, kind: "extra_done", note: item.note, actor }
    )
  );
  await tellCustomer(conv, actor._id, { notice: `✔ Additional work done: ${item.note}` });
  return broadcast(conv, c, updated.project);
};

/** Tick a gate checklist item of the current stage (E3). Internal: customers don't see checklists. */
const checklist = async ({ conversationId, actor, itemKey, done = true }) => {
  const { conv, c } = await withFlow(conversationId);
  activeOnly(conv);
  const state = stateOf(conv.project, c);
  const stage = stageAt(c, state);
  const item = (stage.gates?.checklist || []).find((i) => i.key === itemKey);
  if (!item) throw fail(400, "STEP_UNKNOWN", "That isn't on this stage's checklist");
  await requireRole(actor, conv, stage);
  const value = `${stage.key}:${item.key}`;
  const updated = await apply(
    { _id: conv._id, "project.flow.versionId": conv.project.flow.versionId, "project.flow.stepKey": conv.project.flow.stepKey },
    withHistory({ [done ? "$addToSet" : "$pull"]: { "project.flow.checks": value } }, { conv, c, kind: "checklist", note: `${done ? "✔" : "✗"} ${item.label}`, actor })
  );
  return broadcast(conv, c, updated.project);
};

// ── Reading ───────────────────────────────────────────────────────────────────

/** A project's workflow view for this person (customers: the customer view only). */
const viewFor = async (conversationId, viewer) => {
  const conv = await load(conversationId);
  const c = await workflows.compiledForProject(conv.project);
  const h = helpers();
  const isCustomer = viewer.role === "customer";
  // Customers: their own project. Staff: chat members, admins, "view projects"
  // holders (e.g. leadership) and the people handling any of its stages.
  const allowed = isCustomer
    ? h.isProjectCustomer(conv, viewer._id)
    : h.isMember(conv, viewer._id) ||
      h.ADMIN_ROLES.includes(viewer.role) ||
      require("../../config/permissions").hasPermission(viewer, "projects.view") ||
      (await Promise.all(c.stages.map((s) => roleFor(viewer, conv, s)))).some(Boolean);
  if (!allowed) throw new ApiError(403, "You don't have access to this project");
  const state = stateOf(conv.project, c);
  return isCustomer
    ? { status: conv.project.status, flow: nav.customerView(c, state) }
    : { status: conv.project.status, stage: conv.project.stage, version: c.version, flow: nav.staffView(c, state), dueAt: conv.project.flow?.dueAt || null };
};

/** Customer views for many projects at once (Home): versions compiled once, from the cache. */
const customerViews = async (projects) => {
  const out = new Map();
  for (const p of projects) {
    const c = await workflows.compiledForProject(p.project);
    out.set(String(p._id), nav.customerView(c, stateOf(p.project, c)));
  }
  return out;
};

module.exports = { move, moveToStage, activate, deactivate, tick, addExtra, updateExtra, checklist, viewFor, customerViews, stateOf, roleFor };
