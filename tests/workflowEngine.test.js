const { normaliseTree, WorkflowError, LIMITS } = require("../src/modules/workflows/engine/tree");
const { compile } = require("../src/modules/workflows/engine/compile");
const nav = require("../src/modules/workflows/engine/navigate");
const { diffTrees } = require("../src/modules/workflows/engine/diff");
const { BASIC } = require("../src/modules/workflows/engine/basic");

const errCode = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

// A realistic company workflow:
//   consultation
//   design (in order): concept → renders → redesign (optional) → sign_off
//   site (any order): measure, photos, re_measure (optional)
//   quotation: quote → revised (optional)
//   handover
const SAMPLE = {
  stages: [
    { name: "Consultation" },
    {
      name: "Design",
      customerName: "Your design",
      subStages: [{ name: "Concept" }, { name: "3D renders", showToCustomer: true }, { name: "Redesign", optional: true }, { name: "Sign off" }]
    },
    { name: "Site", subOrder: "any", subStages: [{ name: "Measure" }, { name: "Photos" }, { name: "Re-measure", optional: true }] },
    { name: "Quotation", subStages: [{ name: "Quote" }, { name: "Revised quotation", optional: true }] },
    { name: "Handover", gates: { checklist: [{ label: "Snag list closed" }] } }
  ]
};
const tree = normaliseTree(SAMPLE);
const c = compile(tree, { versionId: "v1", version: 1 });
const state = (stepKey, extra = {}) => ({ stepKey, status: "active", activated: new Set(), ticks: {}, extras: [], checks: new Set(), ...extra });

describe("tree normalisation", () => {
  test("keys come from names, stay unique and survive renames", () => {
    expect(tree.stages.map((s) => s.key)).toEqual(["consultation", "design", "site", "quotation", "handover"]);
    expect(tree.stages[1].subStages.map((s) => s.key)).toEqual(["concept", "s_3d_renders", "redesign", "sign_off"]);
    const renamed = normaliseTree({ stages: [{ key: "design", name: "Interior design" }] });
    expect(renamed.stages[0].key).toBe("design");
  });

  test("generated keys never take a key given later in the list", () => {
    const t = normaliseTree({ stages: [{ name: "Design" }, { key: "design", name: "Old design" }] });
    expect(t.stages.map((s) => s.key)).toEqual(["design_2", "design"]);
  });

  test("defaults: customer name = name, sub-stages hidden (W5), in order (W4)", () => {
    const d = tree.stages[1];
    expect(d.customerName).toBe("Your design");
    expect(tree.stages[0].customerName).toBe("Consultation");
    expect(d.subOrder).toBe("sequential");
    expect(d.subStages[0].showToCustomer).toBe(false);
    expect(d.subStages[1].showToCustomer).toBe(true);
  });

  test("refuses empty, duplicate, oversized and unsafe input", () => {
    expect(errCode(() => normaliseTree({ stages: [] }))).toBe("WORKFLOW_EMPTY");
    expect(errCode(() => normaliseTree({ stages: [{ name: "A1" }, { name: "a1" }] }))).toBe("WORKFLOW_NAME_DUPLICATE");
    expect(errCode(() => normaliseTree({ stages: [{ key: "x1", name: "One" }, { key: "x1", name: "Two" }] }))).toBe("WORKFLOW_KEY_DUPLICATE");
    expect(errCode(() => normaliseTree({ stages: Array.from({ length: LIMITS.stages + 1 }, (_, i) => ({ name: `Stage ${i}` })) }))).toBe("WORKFLOW_LIMIT");
    expect(errCode(() => normaliseTree({ stages: [{ name: "<script>" }] }))).toBe("WORKFLOW_FIELD_INVALID");
    expect(errCode(() => normaliseTree({ stages: [{ name: "Design", subStages: [{ name: "Maybe", optional: true }] }] }))).toBe("WORKFLOW_STAGE_ALL_OPTIONAL");
    expect(errCode(() => normaliseTree({ stages: [{ name: "Design", handlers: ["nope"] }] }))).toBe("WORKFLOW_FIELD_INVALID");
    expect(() => normaliseTree(null)).toThrow(WorkflowError);
  });

  test("the Basic workflow is today's 7 stages with the same keys", () => {
    const b = normaliseTree(BASIC.tree);
    expect(b.stages.map((s) => s.key)).toEqual(["consultation", "site_measurement", "design", "quotation", "production", "installation", "handover"]);
  });
});

describe("compiled steps", () => {
  test("in-order sub-stages are steps; any-order stages are one step with ticks", () => {
    expect(c.steps.map((s) => s.key)).toEqual([
      "consultation",
      "design/concept",
      "design/s_3d_renders",
      "design/redesign",
      "design/sign_off",
      "site",
      "quotation/quote",
      "quotation/revised_quotation",
      "handover"
    ]);
    const site = c.stages[c.stageIndex.get("site")];
    expect(site.any).toBe(true);
    expect(site.requiredMask).toBe(0b011); // measure + photos; re-measure is optional
  });

  test("older projects storing only a stage key land on that stage's first step", () => {
    expect(nav.positionOf(c, "design")).toBe(c.stepIndex.get("design/concept"));
    expect(nav.positionOf(c, "nonsense")).toBe(0);
  });
});

describe("moving", () => {
  test("next skips optional steps that weren't activated", () => {
    const p = nav.planMove(c, state("design/s_3d_renders"), "design/sign_off");
    expect(p.kind).toBe("next");
    expect(errCode(() => nav.planMove(c, state("design/s_3d_renders"), "design/redesign"))).toBe("STEP_NOT_ACTIVE");
  });

  test("an activated optional step becomes part of the path (W5)", () => {
    const s = state("design/s_3d_renders", { activated: new Set(["design/redesign"]) });
    expect(nav.planMove(c, s, "design/redesign").kind).toBe("next");
    // Going straight to sign-off would now skip Redesign: admins only
    expect(errCode(() => nav.planMove(c, s, "design/sign_off"))).toBe("STAGE_SKIP_ADMIN_ONLY");
  });

  test("back needs a reason; skipping needs an admin and a reason", () => {
    expect(errCode(() => nav.planMove(c, state("design/concept"), "consultation"))).toBe("STAGE_REASON_REQUIRED");
    expect(nav.planMove(c, state("design/concept"), "consultation", { note: "Customer changed brief" }).kind).toBe("back");
    expect(errCode(() => nav.planMove(c, state("consultation"), "site", { note: "Measured already" }))).toBe("STAGE_SKIP_ADMIN_ONLY");
    expect(errCode(() => nav.planMove(c, state("consultation"), "design/sign_off", { isAdmin: true }))).toBe("STAGE_REASON_REQUIRED");
    expect(nav.planMove(c, state("consultation"), "design/sign_off", { isAdmin: true, note: "Repeat design" }).kind).toBe("jump");
  });

  test("an any-order stage can't be left until its required sub-stages are ticked", () => {
    expect(errCode(() => nav.planMove(c, state("site", { ticks: { site: 0b001 } }), "quotation/quote"))).toBe("STAGE_BLOCKED");
    expect(nav.planMove(c, state("site", { ticks: { site: 0b011 } }), "quotation/quote").kind).toBe("next");
    // Activating the optional re-measure makes it required too
    const s = state("site", { ticks: { site: 0b011 }, activated: new Set(["site/re_measure"]) });
    expect(errCode(() => nav.planMove(c, s, "quotation/quote"))).toBe("STAGE_BLOCKED");
    expect(nav.planMove(c, { ...s, ticks: { site: 0b111 } }, "quotation/quote").kind).toBe("next");
  });

  test("open additional work and gates block leaving a stage; admins can override with a reason", () => {
    const s = state("quotation/quote", { extras: [{ stageKey: "quotation", note: "Add wardrobe", done: false }] });
    expect(errCode(() => nav.planMove(c, s, "handover"))).toBe("STAGE_BLOCKED");
    expect(errCode(() => nav.planMove(c, s, "handover", { isAdmin: true, override: true }))).toBe("STAGE_BLOCKED"); // no reason
    const p = nav.planMove(c, s, "handover", { isAdmin: true, override: true, note: "Wardrobe moved to phase 2" });
    expect(p.overridden).toBe(true);
    expect(p.blockers[0].code).toBe("EXTRA_WORK_OPEN");
  });

  test("checklist, approval and payment gates", () => {
    const gated = compile(
      normaliseTree({ stages: [{ name: "Design", gates: { approval: true, payment: true, checklist: [{ label: "Moodboard shared" }] } }, { name: "Build" }] })
    );
    const base = state("design");
    const b = nav.stageBlockers(gated, 0, base).map((x) => x.code);
    expect(b).toEqual(["CHECKLIST_INCOMPLETE", "APPROVAL_REQUIRED", "PAYMENT_REQUIRED"]);
    const ok = { ...base, checks: new Set(["design:moodboard_shared"]), gateFacts: { design: { approval: true, payment: true } } };
    expect(nav.planMove(gated, ok, "build").kind).toBe("next");
  });

  test("on-hold and completed projects don't move", () => {
    expect(errCode(() => nav.planMove(c, state("consultation", { status: "on_hold" }), "design/concept"))).toBe("PROJECT_ON_HOLD");
    expect(errCode(() => nav.planMove(c, state("handover", { status: "completed" }), "quotation/quote", { isAdmin: true, note: "Reopen" }))).toBe("PROJECT_COMPLETED");
    expect(nav.planMove(c, state("handover", { status: "completed" }), "handover").kind).toBe("same");
  });
});

describe("views", () => {
  test("progress counts only the steps this project runs", () => {
    expect(nav.progress(c, state("consultation"))).toEqual({ done: 0, total: 7, percent: 0 });
    expect(nav.progress(c, state("site", { activated: new Set(["design/redesign"]) })).total).toBe(8);
  });

  test("the customer sees customer names, shown or activated sub-stages and nothing internal", () => {
    const v = nav.customerView(c, state("design/redesign", { activated: new Set(["design/redesign"]) }));
    const design = v.stages[1];
    expect(design.name).toBe("Your design");
    expect(design.status).toBe("current");
    expect(design.subs.map((s) => s.name)).toEqual(["3D renders", "Redesign"]); // concept and sign-off stay internal
    expect(JSON.stringify(v)).not.toMatch(/handlers|gates|departmentId|Concept/);
  });

  test("staff see every sub-stage with its status and the current blockers", () => {
    const v = nav.staffView(c, state("site", { ticks: { site: 0b001 } }));
    const site = v.stages.find((s) => s.key === "site");
    expect(site.subs.map((s) => s.status)).toEqual(["done", "todo", "inactive"]);
    expect(v.blockers[0].code).toBe("SUBSTAGES_INCOMPLETE");
    expect(v.next).toBe("quotation/quote");
  });
});

describe("diff", () => {
  test("renames, additions, removals and who may publish", () => {
    const edited = normaliseTree({
      stages: [
        { key: "consultation", name: "First meeting" },
        { ...tree.stages[1], subStages: [...tree.stages[1].subStages, { name: "Lighting plan" }] },
        tree.stages[2],
        { key: "quotation", name: "Quotation", subStages: [{ key: "quote", name: "Quote" }] },
        tree.stages[4]
      ]
    });
    const d = diffTrees(tree, edited);
    expect(d.renamed).toEqual([{ kind: "stage", key: "consultation", from: "Consultation", to: "First meeting" }]);
    expect(d.added).toEqual([{ kind: "sub", key: "lighting_plan", name: "Lighting plan", stageKey: "design" }]);
    expect(d.removedSteps).toEqual(["quotation/revised_quotation"]);
    expect([...d.touchedStages].sort()).toEqual(["consultation", "design", "quotation"]);
    expect(d.structural).toBe(false);
  });

  test("adding, removing or reordering stages, or changing handlers, is structural (admins only)", () => {
    expect(diffTrees(tree, { stages: [...tree.stages].reverse() }).structural).toBe(true);
    const handlers = { stages: tree.stages.map((s, i) => (i === 0 ? { ...s, handlers: ["64b7f0c2a1b2c3d4e5f60718"] } : s)) };
    expect(diffTrees(tree, handlers).structural).toBe(true);
    expect(diffTrees(tree, tree).empty).toBe(true);
  });
});
