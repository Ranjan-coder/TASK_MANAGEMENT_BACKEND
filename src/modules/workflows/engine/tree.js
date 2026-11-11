/**
 * Workflow tree: validation and normalisation (project-workflow-plan.md §5.1).
 *
 * Pure (no database). Takes whatever an editor sent and returns a clean tree, or
 * throws WorkflowError with the path of the first problem. Keys are stable ids:
 * existing ones are kept (renames never change them); new stages and sub-stages
 * get a key made from their name, made unique with a Set (O(1) per check).
 */

const LIMITS = Object.freeze({
  stages: 20,
  subStages: 15, // per stage (≤ 31 so a stage's sub-stages fit in one bitmask)
  handlers: 20,
  checklist: 10,
  name: 60,
  description: 300,
  message: 500,
  durationDays: 365,
  paymentDueDays: 90
});

const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const ID_RE = /^[a-f0-9]{24}$/i;
// Plain text: letters, numbers, spaces and common punctuation (no markup, no control characters)
const TEXT_RE = /^[\p{L}\p{N}\p{Zs}&\-.,/'()+:!?#%₹]*$/u;
const SUB_ORDERS = Object.freeze(["sequential", "any"]);

class WorkflowError extends Error {
  constructor(code, message, path = null) {
    super(message);
    this.code = code;
    this.path = path;
    this.status = 400;
  }
}

const fail = (code, message, path) => {
  throw new WorkflowError(code, message, path);
};

const str = (v, { path, max, min = 0, required = false, label }) => {
  if (v === undefined || v === null) {
    if (required) fail("WORKFLOW_FIELD_REQUIRED", `${label} is required`, path);
    return "";
  }
  if (typeof v !== "string") fail("WORKFLOW_FIELD_INVALID", `${label} must be text`, path);
  const s = v.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (required && s.length < Math.max(min, 1)) fail("WORKFLOW_FIELD_REQUIRED", `${label} is required`, path);
  if (s.length < min) fail("WORKFLOW_FIELD_INVALID", `${label} must be at least ${min} characters`, path);
  if (s.length > max) fail("WORKFLOW_FIELD_INVALID", `${label} can be at most ${max} characters`, path);
  if (!TEXT_RE.test(s)) fail("WORKFLOW_FIELD_INVALID", `${label} can only use letters, numbers, spaces and simple punctuation`, path);
  return s;
};

const int = (v, { path, max, label, min = 1 }) => {
  if (v === undefined || v === null || v === "") return null;
  if (!Number.isInteger(v) || v < min || v > max) fail("WORKFLOW_FIELD_INVALID", `${label} must be a whole number from ${min} to ${max}`, path);
  return v;
};

const bool = (v, def) => (v === undefined || v === null ? def : Boolean(v));

const slug = (name) =>
  String(name)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "s_$1")
    .slice(0, 32) || "step";

/** A key that isn't in `used` yet: the given one (if valid), else one made from the name. */
const claimKey = (given, name, used, path) => {
  if (given !== undefined && given !== null && given !== "") {
    if (typeof given !== "string" || !KEY_RE.test(given)) fail("WORKFLOW_KEY_INVALID", "Invalid key", path);
    if (used.has(given)) fail("WORKFLOW_KEY_DUPLICATE", `Key "${given}" is used twice`, path);
    used.add(given);
    return given;
  }
  let base = slug(name);
  if (!/^[a-z]/.test(base)) base = `s_${base}`;
  if (base.length < 2) base = `${base}_x`;
  let key = base;
  for (let n = 2; used.has(key); n += 1) key = `${base.slice(0, 36)}_${n}`;
  used.add(key);
  return key;
};

const ids = (arr, { path, max, label }) => {
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) fail("WORKFLOW_FIELD_INVALID", `${label} must be a list`, path);
  if (arr.length > max) fail("WORKFLOW_FIELD_INVALID", `At most ${max} ${label.toLowerCase()}`, path);
  const seen = new Set();
  for (const id of arr) {
    if (typeof id !== "string" || !ID_RE.test(id)) fail("WORKFLOW_FIELD_INVALID", `${label} has an invalid id`, path);
    seen.add(id.toLowerCase());
  }
  return [...seen];
};

const normaliseGates = (g, path, usedChecklist) => {
  const gates = { approval: false, payment: false, checklist: [] };
  if (g === undefined || g === null) return gates;
  if (typeof g !== "object" || Array.isArray(g)) fail("WORKFLOW_FIELD_INVALID", "Gates must be an object", path);
  gates.approval = bool(g.approval, false);
  gates.payment = bool(g.payment, false);
  const list = g.checklist ?? [];
  if (!Array.isArray(list)) fail("WORKFLOW_FIELD_INVALID", "Checklist must be a list", `${path}.checklist`);
  if (list.length > LIMITS.checklist) fail("WORKFLOW_LIMIT", `At most ${LIMITS.checklist} checklist items per stage`, `${path}.checklist`);
  gates.checklist = list.map((item, i) => {
    const p = `${path}.checklist[${i}]`;
    const label = str(item?.label, { path: `${p}.label`, max: 120, min: 2, required: true, label: "Checklist item" });
    return { key: claimKey(item?.key, label, usedChecklist, `${p}.key`), label };
  });
  return gates;
};

/**
 * @param {object} raw  { stages: [...] } as sent by an editor
 * @returns {{ stages: object[] }} the clean tree
 * @throws {WorkflowError}
 */
const normaliseTree = (raw) => {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.stages)) fail("WORKFLOW_INVALID", "A workflow needs a list of stages", "stages");
  if (raw.stages.length === 0) fail("WORKFLOW_EMPTY", "A workflow needs at least one stage", "stages");
  if (raw.stages.length > LIMITS.stages) fail("WORKFLOW_LIMIT", `At most ${LIMITS.stages} stages`, "stages");

  // One key space for stages and one for sub-stages (step paths are "stage/sub").
  // Pass 1 claims every key the editor sent (existing items), so pass 2 can give
  // new items generated keys that never collide with them.
  const usedStage = new Set();
  const usedSub = new Set();
  const usedStageNames = new Set();
  raw.stages.forEach((s, si) => {
    if (s?.key) claimKey(s.key, "", usedStage, `stages[${si}].key`);
    (Array.isArray(s?.subStages) ? s.subStages : []).forEach((sub, ji) => {
      if (sub?.key) claimKey(sub.key, "", usedSub, `stages[${si}].subStages[${ji}].key`);
    });
  });
  const takeKey = (given, name, set, path) => (given ? given : claimKey(undefined, name, set, path));

  const stages = raw.stages.map((s, si) => {
    const path = `stages[${si}]`;
    if (!s || typeof s !== "object") fail("WORKFLOW_INVALID", "Invalid stage", path);
    const name = str(s.name, { path: `${path}.name`, max: LIMITS.name, min: 2, required: true, label: "Stage name" });
    const nameKey = name.toLowerCase();
    if (usedStageNames.has(nameKey)) fail("WORKFLOW_NAME_DUPLICATE", `Two stages are called "${name}"`, `${path}.name`);
    usedStageNames.add(nameKey);

    const subOrder = s.subOrder ?? "sequential";
    if (!SUB_ORDERS.includes(subOrder)) fail("WORKFLOW_FIELD_INVALID", "Sub-stage order must be in order or any order", `${path}.subOrder`);

    const subsRaw = s.subStages ?? [];
    if (!Array.isArray(subsRaw)) fail("WORKFLOW_FIELD_INVALID", "Sub-stages must be a list", `${path}.subStages`);
    if (subsRaw.length > LIMITS.subStages) fail("WORKFLOW_LIMIT", `At most ${LIMITS.subStages} sub-stages per stage`, `${path}.subStages`);
    const subNames = new Set();
    const subStages = subsRaw.map((sub, ji) => {
      const sp = `${path}.subStages[${ji}]`;
      const subName = str(sub?.name, { path: `${sp}.name`, max: LIMITS.name, min: 2, required: true, label: "Sub-stage name" });
      if (subNames.has(subName.toLowerCase())) fail("WORKFLOW_NAME_DUPLICATE", `Two sub-stages in "${name}" are called "${subName}"`, `${sp}.name`);
      subNames.add(subName.toLowerCase());
      return {
        key: takeKey(sub?.key, subName, usedSub, `${sp}.key`),
        name: subName,
        customerName: str(sub?.customerName, { path: `${sp}.customerName`, max: LIMITS.name, label: "Customer name" }) || subName,
        showToCustomer: bool(sub?.showToCustomer, false), // W5: hidden by default
        optional: bool(sub?.optional, false), // W5: off until activated on a project
        durationDays: int(sub?.durationDays, { path: `${sp}.durationDays`, max: LIMITS.durationDays, label: "Duration (days)" })
      };
    });
    // In-order stages need at least one sub-stage that always runs, or the stage could vanish
    if (subOrder === "sequential" && subStages.length && subStages.every((x) => x.optional)) {
      fail("WORKFLOW_STAGE_ALL_OPTIONAL", `"${name}" needs at least one sub-stage that isn't optional`, `${path}.subStages`);
    }

    const departmentId = s.departmentId ?? null;
    if (departmentId !== null && (typeof departmentId !== "string" || !ID_RE.test(departmentId))) {
      fail("WORKFLOW_FIELD_INVALID", "Invalid department", `${path}.departmentId`);
    }

    return {
      key: takeKey(s.key, name, usedStage, `${path}.key`),
      name,
      customerName: str(s.customerName, { path: `${path}.customerName`, max: LIMITS.name, label: "Customer name" }) || name,
      description: str(s.description, { path: `${path}.description`, max: LIMITS.description, label: "Description" }),
      departmentId: departmentId ? departmentId.toLowerCase() : null,
      handlers: ids(s.handlers, { path: `${path}.handlers`, max: LIMITS.handlers, label: "Handlers" }),
      subOrder,
      subStages,
      durationDays: int(s.durationDays, { path: `${path}.durationDays`, max: LIMITS.durationDays, label: "Duration (days)" }), // E1
      gates: normaliseGates(s.gates, `${path}.gates`, new Set()), // E3
      paymentDueDays: int(s.paymentDueDays, { path: `${path}.paymentDueDays`, max: LIMITS.paymentDueDays, min: 0, label: "Payment due (days)" }), // E4
      entryMessage: str(s.entryMessage, { path: `${path}.entryMessage`, max: LIMITS.message, label: "Customer message" }) // E5
    };
  });

  return { stages };
};

module.exports = { LIMITS, KEY_RE, SUB_ORDERS, WorkflowError, normaliseTree, slug };
