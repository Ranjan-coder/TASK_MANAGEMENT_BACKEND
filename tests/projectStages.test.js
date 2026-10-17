const s = require("../src/config/projectStages");

const plan = (from, to, extra = {}) => s.planTransition({ from, to, ...extra });
const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

describe("project stages", () => {
  test("order, labels and O(1) neighbours", () => {
    expect(s.STAGE_KEYS[0]).toBe("consultation");
    expect(s.LAST).toBe("handover");
    expect(s.LABELS.site_measurement).toBe("Site measurement");
    expect(s.nextStage("design")).toBe("quotation");
    expect(s.prevStage("design")).toBe("site_measurement");
    expect(s.nextStage("handover")).toBeNull();
    expect(s.prevStage("consultation")).toBeNull();
  });

  test("projects with no stage stored count as the first stage", () => {
    expect(s.currentStage({})).toBe("consultation");
    expect(s.currentStage({ stage: "nonsense" })).toBe("consultation");
    expect(s.currentStage({ stage: "production" })).toBe("production");
  });

  test("anyone allowed may move one step forward", () => {
    expect(plan("consultation", "site_measurement")).toEqual({ kind: "next", steps: 1 });
    expect(plan(undefined, "site_measurement").kind).toBe("next");
  });

  test("one step back needs a reason the customer will see", () => {
    expect(code(() => plan("design", "site_measurement"))).toBe("STAGE_REASON_REQUIRED");
    expect(plan("design", "site_measurement", { note: "Re-measure the kitchen" }).kind).toBe("back");
  });

  test("skipping stages is for admins only, with a reason", () => {
    expect(code(() => plan("consultation", "design", { note: "Measured on day one" }))).toBe("STAGE_SKIP_ADMIN_ONLY");
    expect(code(() => plan("consultation", "design", { isAdmin: true }))).toBe("STAGE_REASON_REQUIRED");
    expect(plan("consultation", "design", { isAdmin: true, note: "Measured on day one" })).toEqual({ kind: "jump", steps: 2 });
    expect(plan("installation", "design", { isAdmin: true, note: "Redesign requested" }).kind).toBe("jump");
  });

  test("on-hold and completed projects don't move (a note alone is fine)", () => {
    expect(code(() => plan("design", "quotation", { status: "on_hold" }))).toBe("PROJECT_ON_HOLD");
    expect(code(() => plan("handover", "installation", { status: "completed", isAdmin: true, note: "Snag list" }))).toBe("PROJECT_COMPLETED");
    expect(plan("design", "design", { status: "completed" }).kind).toBe("same");
  });

  test("unknown stages are refused", () => {
    expect(code(() => plan("design", "painting"))).toBe("STAGE_UNKNOWN");
  });
});
