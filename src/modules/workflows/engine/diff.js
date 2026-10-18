/**
 * What changed between two workflow trees, matched by key (renames keep keys).
 * O(n) with Maps. Used for:
 *   - the change summary shown before publishing
 *   - C1: a stage handler may publish only changes inside the stages they handle
 *   - W6: which steps disappeared (projects there need a new place)
 */

const STAGE_FIELDS = ["name", "customerName", "description", "subOrder", "durationDays", "paymentDueDays", "entryMessage"];
const SUB_FIELDS = ["name", "customerName", "showToCustomer", "optional", "durationDays"];
// Who handles a stage decides who may edit it: only admins change these (no self-promotion)
const PRIVILEGED_STAGE_FIELDS = ["departmentId", "handlers"];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const diffTrees = (oldTree, newTree) => {
  const oldStages = new Map((oldTree?.stages || []).map((s, i) => [s.key, { s, i }]));
  const newStages = new Map((newTree?.stages || []).map((s, i) => [s.key, { s, i }]));
  const out = {
    added: [], // { kind: "stage"|"sub", key, name, stageKey? }
    removed: [],
    renamed: [], // { kind, key, from, to, stageKey? }
    changed: [], // { kind, key, stageKey?, fields }
    stageOrderChanged: false,
    structural: false, // stages added, removed or reordered, or who handles a stage changed
    touchedStages: new Set(), // stage keys whose own content changed (handler check)
    removedSteps: [] // step keys that no longer exist
  };

  const oldOrder = [...oldStages.keys()].filter((k) => newStages.has(k));
  const newOrder = [...newStages.keys()].filter((k) => oldStages.has(k));
  out.stageOrderChanged = oldOrder.join("|") !== newOrder.join("|");

  for (const [key, { s }] of oldStages) {
    if (!newStages.has(key)) {
      out.removed.push({ kind: "stage", key, name: s.name });
      out.removedSteps.push(...(s.subStages.length && s.subOrder !== "any" ? s.subStages.map((x) => `${key}/${x.key}`) : [key]));
    }
  }
  for (const [key, { s }] of newStages) {
    const prev = oldStages.get(key)?.s;
    if (!prev) {
      out.added.push({ kind: "stage", key, name: s.name });
      continue;
    }
    const fields = STAGE_FIELDS.filter((f) => !same(prev[f], s[f]));
    if (!same(prev.gates, s.gates)) fields.push("gates");
    const privileged = PRIVILEGED_STAGE_FIELDS.filter((f) => !same(prev[f], s[f]));
    if (prev.name !== s.name) out.renamed.push({ kind: "stage", key, from: prev.name, to: s.name });

    // Sub-stages, matched by key inside the stage
    const oldSubs = new Map(prev.subStages.map((x, i) => [x.key, { x, i }]));
    const newSubs = new Map(s.subStages.map((x, i) => [x.key, { x, i }]));
    const wasSteps = prev.subStages.length && prev.subOrder !== "any";
    const isSteps = s.subStages.length && s.subOrder !== "any";
    let subChanged = false;
    for (const [sk, { x }] of oldSubs) {
      if (!newSubs.has(sk)) {
        out.removed.push({ kind: "sub", key: sk, name: x.name, stageKey: key });
        subChanged = true;
      }
    }
    for (const [sk, { x, i }] of newSubs) {
      const p = oldSubs.get(sk);
      if (!p) {
        out.added.push({ kind: "sub", key: sk, name: x.name, stageKey: key });
        subChanged = true;
        continue;
      }
      const sf = SUB_FIELDS.filter((f) => !same(p.x[f], x[f]));
      if (p.i !== i) sf.push("order");
      if (p.x.name !== x.name) out.renamed.push({ kind: "sub", key: sk, from: p.x.name, to: x.name, stageKey: key });
      if (sf.length) {
        out.changed.push({ kind: "sub", key: sk, stageKey: key, fields: sf });
        subChanged = true;
      }
    }
    // Steps that existed before but not now (sub-stage removed, or the stage's shape changed)
    const oldStepKeys = wasSteps ? prev.subStages.map((x) => `${key}/${x.key}`) : [key];
    const newStepKeys = new Set(isSteps ? s.subStages.map((x) => `${key}/${x.key}`) : [key]);
    out.removedSteps.push(...oldStepKeys.filter((k) => !newStepKeys.has(k)));

    if (fields.length || privileged.length) out.changed.push({ kind: "stage", key, fields: [...fields, ...privileged] });
    if (fields.length || privileged.length || subChanged) out.touchedStages.add(key);
    if (privileged.length) out.structural = true;
  }
  if (out.added.some((a) => a.kind === "stage") || out.removed.some((r) => r.kind === "stage") || out.stageOrderChanged) out.structural = true;
  out.empty = !out.added.length && !out.removed.length && !out.changed.length && !out.stageOrderChanged;
  return out;
};

/** Plain JSON for the API (Set → array). */
const summaryJson = (d) => ({ ...d, touchedStages: [...d.touchedStages] });

module.exports = { diffTrees, summaryJson, STAGE_FIELDS, SUB_FIELDS, PRIVILEGED_STAGE_FIELDS };
