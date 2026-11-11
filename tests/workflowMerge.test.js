const { mergeTrees } = require("../src/modules/workflows/engine/merge");
const { normaliseTree } = require("../src/modules/workflows/engine/tree");

const base = normaliseTree({
  stages: [
    { key: "consult", name: "Consultation" },
    { key: "design", name: "Design", subStages: [{ key: "concept", name: "Concept" }, { key: "signoff", name: "Sign off" }] },
    { key: "quote", name: "Quotation" },
    { key: "build", name: "Production" },
    { key: "handover", name: "Handover" }
  ]
});
const clone = (x) => JSON.parse(JSON.stringify(x));

describe("three-way merge of a standard workflow update (W7)", () => {
  test("changes the company never touched come in; its own edits stay", () => {
    const theirs = clone(base);
    theirs.stages[2].durationDays = 5; // standard adds a duration to Quotation
    theirs.stages[1].subStages.splice(1, 0, { key: "renders", name: "3D renders", showToCustomer: false, optional: false, customerName: "3D renders", durationDays: null });
    const ours = clone(base);
    ours.stages[0].customerName = "First meeting"; // company renamed what customers see
    ours.stages[3].handlers = ["64b7f0c2a1b2c3d4e5f60718"]; // company's own handler

    const { tree, conflicts, changes } = mergeTrees(base, theirs, ours);
    expect(conflicts).toEqual([]);
    expect(tree.stages[0].customerName).toBe("First meeting");
    expect(tree.stages[2].durationDays).toBe(5);
    expect(tree.stages[1].subStages.map((s) => s.key)).toEqual(["concept", "renders", "signoff"]);
    expect(tree.stages[3].handlers).toEqual(["64b7f0c2a1b2c3d4e5f60718"]);
    expect(changes.added).toEqual([{ kind: "sub", key: "renders", stageKey: "design", name: "3D renders" }]);
  });

  test("both changing the same field keeps the company's value and reports a conflict", () => {
    const theirs = clone(base);
    theirs.stages[2].name = "Pricing";
    const ours = clone(base);
    ours.stages[2].name = "Estimate";
    const { tree, conflicts } = mergeTrees(base, theirs, ours);
    expect(tree.stages[2].name).toBe("Estimate");
    expect(conflicts).toEqual([{ kind: "stage", stageKey: "quote", name: "Estimate", field: "name", ours: "Estimate", theirs: "Pricing" }]);
  });

  test("new standard stages land after the same neighbour; company-only stages are kept", () => {
    const theirs = clone(base);
    theirs.stages.splice(4, 0, { key: "install", name: "Installation", subStages: [], subOrder: "sequential", handlers: [], departmentId: null });
    const ours = clone(base);
    ours.stages.splice(1, 0, { ...clone(base.stages[0]), key: "site", name: "Site visit" });
    const { tree } = mergeTrees(base, theirs, ours);
    expect(tree.stages.map((s) => s.key)).toEqual(["consult", "site", "design", "quote", "build", "install", "handover"]);
  });

  test("a stage the standard removed goes only if the company never changed it", () => {
    const theirs = clone(base);
    theirs.stages.splice(3, 1); // standard drops Production
    const untouched = mergeTrees(base, theirs, clone(base));
    expect(untouched.tree.stages.map((s) => s.key)).not.toContain("build");
    const ours = clone(base);
    ours.stages[3].entryMessage = "Your furniture is being made";
    const changed = mergeTrees(base, theirs, ours);
    expect(changed.tree.stages.map((s) => s.key)).toContain("build");
    expect(changed.conflicts[0]).toMatchObject({ stageKey: "build", field: "removed" });
  });

  test("a stage the company removed stays removed; a company reorder is kept", () => {
    const theirs = clone(base);
    theirs.stages[0].description = "Meet the customer";
    const ours = clone(base);
    ours.stages.splice(3, 1); // company dropped Production
    [ours.stages[1], ours.stages[2]] = [ours.stages[2], ours.stages[1]]; // and put Quotation before Design
    const { tree } = mergeTrees(base, theirs, ours);
    expect(tree.stages.map((s) => s.key)).toEqual(["consult", "quote", "design", "handover"]);
    expect(tree.stages[0].description).toBe("Meet the customer");
  });

  test("the merged tree is a valid workflow", () => {
    const theirs = clone(base);
    theirs.stages.push({ key: "aftercare", name: "Aftercare", subStages: [] });
    const { tree } = mergeTrees(base, theirs, clone(base));
    expect(() => normaliseTree(tree)).not.toThrow();
  });
});
