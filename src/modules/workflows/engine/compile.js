/**
 * Compiles a workflow tree into the read-only structure every check uses
 * (project-workflow-plan.md §6). Done once per published version; the result is
 * frozen and cached for good (versions never change).
 *
 * Steps (positions a project can be at):
 *   - a stage without sub-stages              → one step  "stage"
 *   - an in-order stage with sub-stages       → one step per sub-stage  "stage/sub"
 *   - an any-order stage with sub-stages      → one step  "stage"; its sub-stages are
 *                                               ticks (one bit each in a bitmask)
 *
 * Lookups built here:
 *   stepIndex     Map<stepKey, position>             O(1) "where is it"
 *   stageIndex    Map<stageKey, stage position>      O(1)
 *   subPath       Map<"stage/sub", {stage, sub}>     O(1) for activations and ticks
 *   livePrefix    Int32Array: always-running steps before position i
 *                 → "how many steps between" in O(1) (+ activated optional ones)
 *   requiredMask  per any-order stage: bits of the sub-stages that always count
 */

const compile = (tree, meta = {}) => {
  const stages = [];
  const steps = [];
  const stepIndex = new Map();
  const stageIndex = new Map();
  const subPath = new Map();

  tree.stages.forEach((s, si) => {
    const firstStep = steps.length;
    const any = s.subOrder === "any" && s.subStages.length > 0;
    let requiredMask = 0;
    const subs = s.subStages.map((sub, ji) => {
      const path = `${s.key}/${sub.key}`;
      const bit = 1 << ji; // ≤ 15 sub-stages per stage, so it fits
      if (any && !sub.optional) requiredMask |= bit;
      const compiled = Object.freeze({ ...sub, path, bit, index: ji });
      subPath.set(path, { stageIdx: si, sub: compiled });
      return compiled;
    });

    if (!any && subs.length) {
      for (const sub of subs) {
        stepIndex.set(sub.path, steps.length);
        steps.push(Object.freeze({ key: sub.path, stageIdx: si, subKey: sub.key, optional: sub.optional, any: false }));
      }
    } else {
      stepIndex.set(s.key, steps.length);
      steps.push(Object.freeze({ key: s.key, stageIdx: si, subKey: null, optional: false, any }));
    }

    stageIndex.set(s.key, si);
    stages.push(
      Object.freeze({
        ...s,
        index: si,
        any,
        subs: Object.freeze(subs),
        requiredMask,
        firstStep,
        lastStep: steps.length - 1,
        handlerSet: new Set(s.handlers.map(String))
      })
    );
  });

  // livePrefix[i] = number of non-optional steps in positions [0, i)
  const livePrefix = new Int32Array(steps.length + 1);
  for (let i = 0; i < steps.length; i += 1) livePrefix[i + 1] = livePrefix[i] + (steps[i].optional ? 0 : 1);

  return Object.freeze({
    versionId: meta.versionId ? String(meta.versionId) : null,
    version: meta.version ?? null,
    orgId: meta.orgId ? String(meta.orgId) : null,
    stages: Object.freeze(stages),
    steps: Object.freeze(steps),
    stepIndex,
    stageIndex,
    subPath,
    livePrefix,
    firstStepKey: steps[0].key
  });
};

module.exports = { compile };
