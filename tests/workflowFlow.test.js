/**
 * Project workflows against a real MongoDB (in-memory): organisation copies,
 * moving projects (older and custom-workflow ones), races, optional steps,
 * any-order ticks, handlers, additional work, gates, payment triggers (E4),
 * overdue alerts (E1) and organisation isolation of the version cache.
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const Department = require("../src/models/Department");
const Conversation = require("../src/models/Conversation");
const ProjectFinance = require("../src/models/ProjectFinance");
const Notification = require("../src/models/Notification");
const Workflow = require("../src/modules/workflows/models/Workflow");
const WorkflowVersion = require("../src/modules/workflows/models/WorkflowVersion");
const { WorkflowTemplate } = require("../src/modules/workflows/models/WorkflowTemplate");
const workflows = require("../src/modules/workflows/workflow.service");
const versionCache = require("../src/modules/workflows/versionCache");
const flow = require("../src/modules/workflows/projectFlow.service");
const overdue = require("../src/modules/workflows/overdue.service");
const { normaliseTree } = require("../src/modules/workflows/engine/tree");

jest.setTimeout(120000);

let mongod;
let orgA;
let orgB;
const people = {};
const inA = (fn) => tenant.runInOrg(orgA._id, fn);
const code = async (p) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err.errors?.[0]?.code || err.code || err.message;
  }
};

const mkUser = (role, name, extra = {}) =>
  inA(() => User.create({ name, email: `${name.toLowerCase()}@example.com`, role, password: "x".repeat(60), ...extra }));

const mkProject = (fields = {}) =>
  inA(() =>
    Conversation.create({
      type: "group",
      name: fields.name || "Test project",
      createdBy: people.admin._id,
      members: [
        { user: people.customer._id, role: "member" },
        { user: people.lead._id, role: "admin" }
      ],
      project: { status: "active", customers: [people.customer._id], leadDesigner: people.lead._id, createdBy: people.admin._id, ...fields.project }
    })
  );

const SAMPLE = {
  stages: [
    { name: "Consultation" },
    { name: "Design", subStages: [{ name: "Concept" }, { name: "Renders", showToCustomer: true }, { name: "Redesign", optional: true }, { name: "Sign off" }] },
    { name: "Site", subOrder: "any", subStages: [{ name: "Measure" }, { name: "Photos" }, { name: "Re-measure", optional: true }] },
    { name: "Quotation", durationDays: 5, paymentDueDays: 2, gates: { payment: false } },
    { name: "Production", gates: { approval: true, checklist: [{ label: "Materials ordered" }] } },
    { name: "Handover" }
  ]
};

/** Publishes a version directly (the editor arrives in Phase 2). */
const publish = async (raw) =>
  inA(async () => {
    const { workflow } = await workflows.current();
    const tree = normaliseTree(raw);
    const next = workflow.currentVersion + 1;
    const v = await WorkflowVersion.create({ workflowId: workflow._id, version: next, tree, source: "edit" });
    await Workflow.updateOne({ _id: workflow._id }, { $set: { currentVersion: next, currentVersionId: v._id } });
    workflows.invalidate();
    return v;
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  [orgA, orgB] = await Organisation.create([
    { name: "Alpha Interiors", slug: "alpha" },
    { name: "Beta Homes", slug: "beta" }
  ]);
  people.admin = await mkUser("admin", "Admin");
  people.lead = await mkUser("user", "Lead");
  people.handler = await mkUser("user", "Handler");
  people.head = await mkUser("user", "Head");
  people.outsider = await mkUser("user", "Outsider");
  people.customer = await mkUser("customer", "Customer", { phone: "+919000000001", phoneVerified: true });
  people.siteDept = await inA(() => Department.create({ name: "Site team", key: "siteteam", head: people.head._id }));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("organisation copies (W1, W2)", () => {
  test("first use copies the Basic standard workflow as version 1, once per organisation", async () => {
    const a = await inA(() => workflows.current());
    const b = await tenant.runInOrg(orgB._id, () => workflows.current());
    expect(a.workflow.currentVersion).toBe(1);
    expect(String(a.currentVersionId)).not.toBe(String(b.currentVersionId));
    const c = await inA(() => workflows.currentCompiled());
    expect(c.stages.map((s) => s.key)).toEqual(["consultation", "site_measurement", "design", "quotation", "production", "installation", "handover"]);
    expect(await WorkflowTemplate.countDocuments()).toBe(1);
    expect(await tenant.runAsSystem(() => Workflow.countDocuments())).toBe(2);
  });

  test("a published version can never be changed", async () => {
    const { currentVersionId } = await inA(() => workflows.current());
    await expect(inA(() => WorkflowVersion.updateOne({ _id: currentVersionId }, { $set: { version: 9 } }))).rejects.toThrow(/can't be changed/);
  });

  test("the version cache never hands one organisation another's workflow", async () => {
    const { currentVersionId } = await inA(() => workflows.current());
    expect(await inA(() => versionCache.get(currentVersionId))).toBeTruthy(); // cached now
    expect(await tenant.runInOrg(orgB._id, () => versionCache.get(currentVersionId))).toBeNull();
  });
});

describe("older projects (no stored flow)", () => {
  test("move on version 1 from their stored stage; the flow is created in the same write", async () => {
    const p = await mkProject({ project: { stage: "design" } });
    const view = await inA(() => flow.move({ conversationId: p._id, actor: people.lead, to: "quotation", from: "design" }));
    expect(view.move).toBe("next");
    const raw = await Conversation.collection.findOne({ _id: p._id });
    expect(raw.project.stage).toBe("quotation");
    expect(raw.project.flow.version).toBe(1);
    expect(raw.project.stageHistory.at(-1)).toMatchObject({ stage: "quotation", step: "quotation", from: "design", kind: "next" });
  });
});

describe("a custom workflow", () => {
  let project;
  let v2;

  beforeAll(async () => {
    const tree = JSON.parse(JSON.stringify(SAMPLE));
    tree.stages[1].handlers = [String(people.handler._id)];
    tree.stages[2].departmentId = String(people.siteDept._id);
    v2 = await publish(tree);
    const c = await inA(() => workflows.currentCompiled());
    project = await mkProject({ project: { stage: "consultation", flow: { versionId: c.versionId, version: c.version, stepKey: "consultation" } } });
  });

  test("next steps through in-order sub-stages", async () => {
    await inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "design/concept", from: "consultation" }));
    const v = await inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "design/renders", from: "design/concept" }));
    expect(v.flow.stepKey).toBe("design/renders");
    expect(v.version).toBe(v2.version);
  });

  test("two people pressing next at once: exactly one wins", async () => {
    const results = await Promise.allSettled([
      inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "design/sign_off", from: "design/renders" })),
      inA(() => flow.move({ conversationId: project._id, actor: people.admin, to: "design/sign_off", from: "design/renders" }))
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason.errors[0].code).toBe("STEP_CHANGED");
    // Put it back for the next tests
    await inA(() => flow.move({ conversationId: project._id, actor: people.admin, to: "design/renders", from: "design/sign_off", note: "Re-test redesign" }));
  });

  test("a stage handler can add an optional step (W5), which the customer then sees", async () => {
    expect(await code(inA(() => flow.activate({ conversationId: project._id, actor: people.handler, path: "design/redesign", note: "x" })))).toBe("STAGE_REASON_REQUIRED");
    await inA(() => flow.activate({ conversationId: project._id, actor: people.handler, path: "design/redesign", note: "Customer wants a darker palette" }));
    const customerView = await inA(() => flow.viewFor(project._id, people.customer));
    const design = customerView.flow.stages.find((s) => s.key === "design");
    expect(design.subs.map((s) => s.name)).toEqual(["Renders", "Redesign"]);
    expect(JSON.stringify(customerView)).not.toMatch(/Concept|handlers|gates/);
    const v = await inA(() => flow.move({ conversationId: project._id, actor: people.handler, to: "design/redesign", from: "design/renders" }));
    expect(v.flow.stepKey).toBe("design/redesign");
  });

  test("staff outside the project and customers can't move it", async () => {
    expect(await code(inA(() => flow.move({ conversationId: project._id, actor: people.outsider, to: "design/sign_off", from: "design/redesign" })))).toBe("NOT_STAGE_HANDLER");
    expect(await code(inA(() => flow.move({ conversationId: project._id, actor: people.customer, to: "design/sign_off", from: "design/redesign" })))).toBe("NOT_STAGE_HANDLER");
  });

  test("an any-order stage needs its ticks; two ticks at once both count (atomic $bit)", async () => {
    await inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "design/sign_off", from: "design/redesign" }));
    await inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "site", from: "design/sign_off" }));
    expect(await code(inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "quotation", from: "site" })))).toBe("STAGE_BLOCKED");
    // The site department's head is a handler of this stage
    await Promise.all([
      inA(() => flow.tick({ conversationId: project._id, actor: people.head, path: "site/measure", done: true })),
      inA(() => flow.tick({ conversationId: project._id, actor: people.lead, path: "site/photos", done: true }))
    ]);
    const raw = await Conversation.collection.findOne({ _id: project._id });
    expect(raw.project.flow.ticks.site).toBe(0b011);
  });

  test("entering a stage sets its due date (E1) and makes its linked payment due (E4)", async () => {
    await inA(() => ProjectFinance.create({ conversation: project._id, contractValuePaise: 100000, milestones: [{ title: "Booking", amountPaise: 10000, stageKey: "quotation" }] }));
    const before = Date.now();
    await inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "quotation", from: "site" }));
    const raw = await Conversation.collection.findOne({ _id: project._id });
    expect(raw.project.flow.dueAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 864e5 - 1000);
    const fin = await ProjectFinance.collection.findOne({ conversation: project._id });
    expect(fin.milestones[0].dueDate.getTime()).toBeGreaterThanOrEqual(before + 2 * 864e5 - 1000);
  });

  test("additional work (C2) blocks leaving its stage until done", async () => {
    await inA(() => flow.addExtra({ conversationId: project._id, actor: people.lead, stageKey: "quotation", note: "Quote the study table too" }));
    expect(await code(inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "production", from: "quotation" })))).toBe("STAGE_BLOCKED");
    const raw = await Conversation.collection.findOne({ _id: project._id });
    await inA(() => flow.updateExtra({ conversationId: project._id, actor: people.lead, extraId: raw.project.flow.extras[0]._id, action: "done" }));
    await inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "production", from: "quotation" }));
  });

  test("gates (E3): checklist and design approval before leaving; admins may override with a reason", async () => {
    expect(await code(inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "handover", from: "production" })))).toBe("STAGE_BLOCKED");
    await inA(() => flow.checklist({ conversationId: project._id, actor: people.lead, itemKey: "materials_ordered", done: true }));
    const err = await inA(() => flow.move({ conversationId: project._id, actor: people.lead, to: "handover", from: "production" })).catch((e) => e);
    expect(err.errors[0].blockers.map((b) => b.code)).toEqual(["APPROVAL_REQUIRED"]);
    const v = await inA(() => flow.move({ conversationId: project._id, actor: people.admin, to: "handover", from: "production", override: true, note: "Approved on WhatsApp, recorded" }));
    expect(v.overridden).toBe(true);
  });

  test("the customer's Home shows stage changes but not internal ticks or sub-stage notes", async () => {
    const extras = require("../src/services/projectExtras.service");
    const mine = await inA(() => extras.listMyProjects(people.customer._id));
    const p = mine.find((x) => String(x._id) === String(project._id));
    const kinds = p.stageHistory.map((h) => h.kind);
    expect(kinds).not.toContain("tick");
    expect(kinds).not.toContain("checklist");
    // "Re-test redesign" was a staff note on a move inside Design: internal
    expect(p.stageHistory.some((h) => h.note === "Re-test redesign")).toBe(false);
    // Stage changes and what they were told about are there
    expect(p.stageHistory.some((h) => h.stage === "quotation" && h.kind === "next")).toBe(true);
    expect(kinds).toContain("activate");
    expect(p.flow.stages.map((s) => s.name)).toContain("Design");
  });

  test("a payment line can be linked to a stage of the project's own workflow (E4)", async () => {
    const payments = require("../src/services/payments.service");
    const c = await inA(() => workflows.currentCompiled());
    const p2 = await mkProject({ name: "Payments project", project: { stage: "consultation", flow: { versionId: c.versionId, version: c.version, stepKey: "consultation" } } });
    const base = { conversationId: p2._id, admin: people.admin, contractValuePaise: 100000, gstRatePct: 18, notes: "" };
    expect(await code(inA(() => payments.saveSchedule({ ...base, milestones: [{ title: "Booking", amountPaise: 10000, stageKey: "nope" }] })))).toMatch(/doesn't have/);
    await inA(() => payments.saveSchedule({ ...base, milestones: [{ title: "Booking", amountPaise: 10000, stageKey: "quotation" }] }));
    const view = await inA(() => payments.adminGet(p2._id));
    expect(view.finance.milestones[0].stageKey).toBe("quotation");
    expect(view.stages.map((s) => s.key)).toContain("quotation");
  });

  test("the time-in-stage report (E2) measures finished stages and current ones", async () => {
    const { stageReport } = require("../src/modules/workflows/report.service");
    const r = await inA(() => stageReport({ days: 30 }));
    const byKey = Object.fromEntries(r.rows.map((x) => [x.stage, x]));
    expect(r.rows.slice(0, 6).map((x) => x.stage)).toEqual(["consultation", "design", "site", "quotation", "production", "handover"]);
    expect(byKey.design.finished).toBeGreaterThanOrEqual(1); // the project passed through Design
    expect(byKey.quotation.targetDays).toBe(5);
    expect(byKey.handover.inStageNow).toBeGreaterThanOrEqual(1);
    expect(typeof r.bottleneck).toBe("string");
  });

  test("overdue stages alert the people handling them once (E1)", async () => {
    const late = await mkProject({
      name: "Late project",
      project: { stage: "quotation", flow: { versionId: v2._id, version: v2.version, stepKey: "quotation", dueAt: new Date(Date.now() - 3 * 864e5) } }
    });
    expect(await inA(() => overdue.processDue())).toBe(1);
    expect(await inA(() => overdue.processDue())).toBe(0); // claimed: no second alert
    const n = await inA(() => Notification.countDocuments({ recipient: people.lead._id, title: /Running late: Late project/ }));
    expect(n).toBe(1);
    await Conversation.collection.deleteOne({ _id: late._id });
  });
});
