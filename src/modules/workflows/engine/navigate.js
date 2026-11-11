/**
 * Moving a project through a compiled workflow (project-workflow-plan.md §7).
 * Pure: the caller passes the project's state and the facts it looked up.
 *
 * Project state (stored on the project, see projectFlow.service.js):
 *   stepKey     where it is ("stage" or "stage/sub")
 *   status      active | on_hold | completed
 *   activated   Set of optional sub-stage paths switched on for this project (W5)
 *   ticks       { stageKey: bitmask } ticked sub-stages of any-order stages (W4)
 *   extras      [{ stageKey, done }] "Additional work" items (C2)
 *   checks      Set of "stage:item" checklist items done (E3)
 *   gateFacts   { [stageKey]: { approval: bool, payment: bool } } (E3, looked up by the caller)
 *
 * Costs: position O(1); next/previous O(k) where k = optional steps skipped (≤ 15);
 * "how many steps between" O(1) + O(activated); blockers O(sub-stages of one stage).
 */

const MIN_REASON = 5;

class FlowError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Position of a step key. Older projects store a stage key: that stage's first step. */
const positionOf = (c, stepKey) => {
  if (c.stepIndex.has(stepKey)) return c.stepIndex.get(stepKey);
  const si = c.stageIndex.get(String(stepKey || "").split("/")[0]);
  return si === undefined ? 0 : c.stages[si].firstStep;
};

const isLive = (c, j, activated) => !c.steps[j].optional || activated.has(c.steps[j].key);

const nextLive = (c, i, activated) => {
  for (let j = i + 1; j < c.steps.length; j += 1) if (isLive(c, j, activated)) return j;
  return -1;
};

const prevLive = (c, i, activated) => {
  for (let j = i - 1; j >= 0; j -= 1) if (isLive(c, j, activated)) return j;
  return -1;
};

/** Live steps in positions (a, b], a < b: O(1) from the prefix sums + activated optional ones. */
const liveBetween = (c, a, b, activated) => {
  let n = c.livePrefix[b + 1] - c.livePrefix[a + 1];
  for (const key of activated) {
    const j = c.stepIndex.get(key);
    if (j !== undefined && j > a && j <= b && c.steps[j].optional) n += 1;
  }
  return n;
};

/** Bits that must be ticked in an any-order stage: always-required + activated optional ones. */
const requiredBits = (stage, activated) => {
  let mask = stage.requiredMask;
  for (const sub of stage.subs) if (sub.optional && activated.has(sub.path)) mask |= sub.bit;
  return mask;
};

/** What stops a project leaving this stage (empty = free to go). */
const stageBlockers = (c, stageIdx, state) => {
  const stage = c.stages[stageIdx];
  const activated = state.activated || new Set();
  const out = [];
  if (stage.any) {
    const need = requiredBits(stage, activated);
    const done = Number(state.ticks?.[stage.key] || 0);
    if ((done & need) !== need) {
      const missing = stage.subs.filter((s) => need & s.bit && !(done & s.bit)).map((s) => s.name);
      out.push({ code: "SUBSTAGES_INCOMPLETE", message: `Still to do in ${stage.name}: ${missing.join(", ")}`, items: missing });
    }
  }
  const openExtras = (state.extras || []).filter((x) => x.stageKey === stage.key && !x.done);
  if (openExtras.length) out.push({ code: "EXTRA_WORK_OPEN", message: `${openExtras.length} additional work item(s) in ${stage.name} aren't done`, items: openExtras.map((x) => x.note) });

  const gates = stage.gates || {};
  const missingChecks = (gates.checklist || []).filter((it) => !state.checks?.has(`${stage.key}:${it.key}`)).map((it) => it.label);
  if (missingChecks.length) out.push({ code: "CHECKLIST_INCOMPLETE", message: `Checklist not done: ${missingChecks.join(", ")}`, items: missingChecks });
  const facts = state.gateFacts?.[stage.key] || {};
  if (gates.approval && !facts.approval) out.push({ code: "APPROVAL_REQUIRED", message: "The customer hasn't approved a design in this stage yet" });
  if (gates.payment && !facts.payment) out.push({ code: "PAYMENT_REQUIRED", message: "The payment linked to this stage isn't confirmed yet" });
  return out;
};

/**
 * Decides whether a move is allowed and what kind it is.
 * @returns {{ kind: "same"|"next"|"back"|"jump", from, to, fromStage, toStage, crossesStage, overridden, blockers }}
 * @throws {FlowError}
 */
const planMove = (c, state, toKey, { isAdmin = false, note = "", override = false } = {}) => {
  const from = positionOf(c, state.stepKey);
  const to = c.stepIndex.get(toKey);
  if (to === undefined) throw new FlowError("STEP_UNKNOWN", "That step isn't in this project's workflow");
  const base = { from, to, fromStage: c.steps[from].stageIdx, toStage: c.steps[to].stageIdx };
  if (to === from) return { ...base, kind: "same", crossesStage: false, overridden: false, blockers: [] };

  if (state.status === "completed") throw new FlowError("PROJECT_COMPLETED", "This project is completed. An admin can reopen it to change the stage.", 409);
  if (state.status === "on_hold") throw new FlowError("PROJECT_ON_HOLD", "This project is on hold. Resume it first.", 409);

  const activated = state.activated || new Set();
  if (!isLive(c, to, activated)) {
    const sub = c.subPath.get(c.steps[to].key)?.sub;
    throw new FlowError("STEP_NOT_ACTIVE", `"${sub?.name || toKey}" isn't part of this project. Add it first.`);
  }

  const reasonOk = String(note || "").trim().length >= MIN_REASON;
  const forward = to > from;
  const distance = forward ? liveBetween(c, from, to, activated) : liveBetween(c, to, from, activated);
  let kind;
  if (distance === 1) kind = forward ? "next" : "back";
  else {
    if (!isAdmin) throw new FlowError("STAGE_SKIP_ADMIN_ONLY", "Steps move one at a time. Only an admin can skip steps.", 403);
    kind = "jump";
  }
  if ((kind === "back" || kind === "jump") && !reasonOk) {
    throw new FlowError("STAGE_REASON_REQUIRED", kind === "back" ? "Say why it's going back (the customer may see it)." : "Say why steps are being skipped.");
  }

  // Leaving the current stage forwards: its sub-stages, extra work and gates must be done
  const crossesStage = base.toStage !== base.fromStage;
  let blockers = [];
  let overridden = false;
  if (forward && crossesStage) {
    blockers = stageBlockers(c, base.fromStage, state);
    if (blockers.length) {
      if (!(isAdmin && override && reasonOk)) {
        throw new FlowError("STAGE_BLOCKED", blockers.map((b) => b.message).join(" · "), 409, blockers);
      }
      overridden = true;
    }
  }
  return { ...base, kind, crossesStage, overridden, blockers };
};

// ── Views ─────────────────────────────────────────────────────────────────────

/** "Step 7 of 19" counting only the steps this project actually runs. */
const progress = (c, state) => {
  const activated = state.activated || new Set();
  const at = positionOf(c, state.stepKey);
  const last = c.steps.length - 1;
  const total = liveBetween(c, -1, last, activated);
  const done = at > 0 ? liveBetween(c, -1, at - 1, activated) : 0;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
};

const subStatus = (stage, sub, at, state, activated) => {
  if (sub.optional && !activated.has(sub.path)) return "inactive";
  if (stage.any) return Number(state.ticks?.[stage.key] || 0) & sub.bit ? "done" : "todo";
  const j = stage.firstStep + sub.index; // in-order stage: one step per sub-stage, in order
  return j < at ? "done" : j === at ? "current" : "upcoming";
};

/** Everything staff see: internal names, every sub-stage, blockers of the current stage. */
const staffView = (c, state) => {
  const activated = state.activated || new Set();
  const at = positionOf(c, state.stepKey);
  const curStage = c.steps[at].stageIdx;
  return {
    stepKey: c.steps[at].key,
    stageKey: c.stages[curStage].key,
    progress: progress(c, state),
    next: (() => {
      const j = nextLive(c, at, activated);
      return j < 0 ? null : c.steps[j].key;
    })(),
    prev: (() => {
      const j = prevLive(c, at, activated);
      return j < 0 ? null : c.steps[j].key;
    })(),
    blockers: stageBlockers(c, curStage, state),
    stages: c.stages.map((s) => ({
      key: s.key,
      name: s.name,
      customerName: s.customerName,
      status: s.index < curStage ? "done" : s.index === curStage ? "current" : "upcoming",
      any: s.any,
      durationDays: s.durationDays,
      gates: s.gates,
      subs: s.subs.map((sub) => ({ key: sub.key, path: sub.path, name: sub.name, optional: sub.optional, showToCustomer: sub.showToCustomer, status: subStatus(s, sub, at, state, activated) })),
      extras: (state.extras || []).filter((x) => x.stageKey === s.key),
      checklist: (s.gates?.checklist || []).map((it) => ({ ...it, done: Boolean(state.checks?.has(`${s.key}:${it.key}`)) }))
    }))
  };
};

/**
 * What the customer sees: customer names only; sub-stages only if shown to customers
 * or activated on their project (W5); "Additional work" notes in their project.
 * Never internal names, handlers, hidden steps or gates.
 */
const customerView = (c, state) => {
  const activated = state.activated || new Set();
  const at = positionOf(c, state.stepKey);
  const curStage = c.steps[at].stageIdx;
  return {
    progress: progress(c, state),
    stages: c.stages.map((s) => {
      const visibleSubs = s.subs.filter((sub) => sub.showToCustomer || (sub.optional && activated.has(sub.path)));
      return {
        key: s.key,
        name: s.customerName,
        status: s.index < curStage ? "done" : s.index === curStage ? "current" : "upcoming",
        subs: visibleSubs.map((sub) => ({ name: sub.customerName, status: subStatus(s, sub, at, state, activated) })),
        extras: (state.extras || []).filter((x) => x.stageKey === s.key).map((x) => ({ note: x.note, done: Boolean(x.done) }))
      };
    })
  };
};

module.exports = {
  MIN_REASON,
  FlowError,
  positionOf,
  isLive,
  nextLive,
  prevLive,
  liveBetween,
  requiredBits,
  stageBlockers,
  planMove,
  progress,
  staffView,
  customerView
};
