/**
 * Three-way merge of workflow trees (project-workflow-plan.md §7.5, W7).
 *
 *   base   = the standard version the company last took
 *   theirs = the new standard version (product owner)
 *   ours   = the company's workflow now (its own edits)
 *
 * Matched by key (renames keep keys), one pass over Maps: O(stages + sub-stages).
 * Per field: unchanged by us → take theirs; unchanged by them → keep ours; both
 * changed the same way → fine; both changed differently → keep ours and report a
 * conflict. Who handles a stage (department, handlers) is the company's alone and
 * never comes from a standard. Stages/sub-stages:
 *   - new in theirs (not in base)       → added, placed after the same neighbour
 *   - removed by theirs, untouched by us → removed; changed by us → kept + conflict
 *   - removed by us                      → stays removed
 *   - only ours                          → kept
 * Order: if we never reordered, take theirs' order; otherwise keep ours.
 */

const STAGE_FIELDS = ["name", "customerName", "description", "subOrder", "durationDays", "paymentDueDays", "entryMessage", "gates"];
const SUB_FIELDS = ["name", "customerName", "showToCustomer", "optional", "durationDays"];
const COMPANY_ONLY = ["departmentId", "handlers"];

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const byKey = (list) => new Map((list || []).map((x, i) => [x.key, { x, i }]));

/** Field-wise merge of one item; returns the merged item and any conflicts. */
const mergeFields = (b, t, o, fields, where) => {
  const out = { ...o };
  const conflicts = [];
  for (const f of fields) {
    if (eq(o[f], b?.[f])) out[f] = t[f]; // we didn't change it: take theirs
    else if (eq(t[f], b?.[f]) || eq(t[f], o[f])) out[f] = o[f]; // they didn't (or same change)
    else {
      out[f] = o[f];
      conflicts.push({ ...where, field: f, ours: o[f], theirs: t[f] });
    }
  }
  return { out, conflicts };
};

/**
 * Orders merged keys: theirs' order if we kept base's order, else ours'; keys new
 * in theirs are placed after their nearest preceding neighbour that exists.
 */
const orderKeys = (baseList, theirList, ourList, keep) => {
  const baseOrder = baseList.map((x) => x.key).filter((k) => keep.has(k));
  const ourOrder = ourList.map((x) => x.key).filter((k) => keep.has(k));
  const reordered = baseOrder.filter((k) => ourOrder.includes(k)).join("|") !== ourOrder.filter((k) => baseOrder.includes(k)).join("|");
  const primary = reordered ? ourList : theirList;
  const result = primary.map((x) => x.key).filter((k) => keep.has(k));
  const placed = new Set(result);
  // Anything kept but not in the primary list (ours-only when using theirs' order, or theirs-new when using ours')
  const secondary = reordered ? theirList : ourList;
  secondary.forEach((x, i) => {
    if (!keep.has(x.key) || placed.has(x.key)) return;
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j -= 1) at = result.indexOf(secondary[j].key);
    result.splice(at + 1, 0, x.key);
    placed.add(x.key);
  });
  return result;
};

const mergeTrees = (base, theirs, ours) => {
  const B = byKey(base?.stages);
  const T = byKey(theirs?.stages);
  const O = byKey(ours?.stages);
  const conflicts = [];
  const changes = { added: [], removed: [], updated: [] };
  const merged = new Map();

  const allKeys = new Set([...B.keys(), ...T.keys(), ...O.keys()]);
  for (const key of allKeys) {
    const b = B.get(key)?.x;
    const t = T.get(key)?.x;
    const o = O.get(key)?.x;
    if (o && t) {
      const { out, conflicts: c } = mergeFields(b, t, o, STAGE_FIELDS, { kind: "stage", stageKey: key, name: o.name });
      conflicts.push(...c);
      for (const f of COMPANY_ONLY) out[f] = o[f];
      out.subStages = mergeSubs(b?.subStages || [], t.subStages || [], o.subStages || [], key, conflicts, changes);
      if (!eq(out, o)) changes.updated.push({ kind: "stage", key, name: out.name });
      merged.set(key, out);
    } else if (t && !o && !b) {
      merged.set(key, { ...t, departmentId: null, handlers: [] }); // new standard stage
      changes.added.push({ kind: "stage", key, name: t.name });
    } else if (o && !t && b) {
      // The standard removed it: drop it only if we never changed it
      if (eq({ ...o, departmentId: null, handlers: [] }, { ...b, departmentId: null, handlers: [] })) changes.removed.push({ kind: "stage", key, name: o.name });
      else {
        merged.set(key, o);
        conflicts.push({ kind: "stage", stageKey: key, name: o.name, field: "removed", ours: "kept (you changed it)", theirs: "removed" });
      }
    } else if (o && !t && !b) merged.set(key, o); // the company's own stage
    // b && t && !o: we removed it → stays removed;  b only: gone on both sides
  }

  const order = orderKeys(base?.stages || [], theirs?.stages || [], ours?.stages || [], new Set(merged.keys()));
  return { tree: { stages: order.map((k) => merged.get(k)) }, conflicts, changes };
};

const mergeSubs = (base, theirs, ours, stageKey, conflicts, changes) => {
  const B = byKey(base);
  const T = byKey(theirs);
  const O = byKey(ours);
  const merged = new Map();
  for (const key of new Set([...B.keys(), ...T.keys(), ...O.keys()])) {
    const b = B.get(key)?.x;
    const t = T.get(key)?.x;
    const o = O.get(key)?.x;
    if (o && t) {
      const { out, conflicts: c } = mergeFields(b, t, o, SUB_FIELDS, { kind: "sub", stageKey, subKey: key, name: o.name });
      conflicts.push(...c);
      merged.set(key, out);
    } else if (t && !o && !b) {
      merged.set(key, t);
      changes.added.push({ kind: "sub", key, stageKey, name: t.name });
    } else if (o && !t && b) {
      if (eq(o, b)) changes.removed.push({ kind: "sub", key, stageKey, name: o.name });
      else {
        merged.set(key, o);
        conflicts.push({ kind: "sub", stageKey, subKey: key, name: o.name, field: "removed", ours: "kept (you changed it)", theirs: "removed" });
      }
    } else if (o && !t && !b) merged.set(key, o);
  }
  return orderKeys(base, theirs, ours, new Set(merged.keys())).map((k) => merged.get(k));
};

module.exports = { mergeTrees };
