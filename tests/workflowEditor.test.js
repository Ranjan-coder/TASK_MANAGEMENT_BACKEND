/**
 * The workflow editor against a real MongoDB (in-memory): who may change what
 * (W3, C1), draft revisions, publishing, reference checks and moving running
 * projects to a new version (W6).
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const Conversation = require("../src/models/Conversation");
const Notification = require("../src/models/Notification");
const editor = require("../src/modules/workflows/editor.service");
const workflows = require("../src/modules/workflows/workflow.service");
const flow = require("../src/modules/workflows/projectFlow.service");

jest.setTimeout(120000);

let mongod;
let org;
const p = {};
const inOrg = (fn) => tenant.runInOrg(org._id, fn);
const code = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.errors?.[0]?.code || err.message;
  }
};
const mkUser = (role, name) => inOrg(() => User.create({ name, email: `${name.toLowerCase()}@example.com`, role, password: "x".repeat(60) }));
const state = () => inOrg(() => editor.editorState(p.admin));
const save = (actor, tree) => state().then((s) => inOrg(() => editor.saveDraft(actor, { tree, revision: s.draftRevision })));
const publish = (actor) => state().then((s) => inOrg(() => editor.publish(actor, { revision: s.draftRevision })));

const V2 = (handlerId) => ({
  stages: [
    { key: "consultation", name: "Consultation" },
    { key: "design", name: "Design", handlers: [handlerId], subStages: [{ name: "Concept" }, { name: "Redesign", optional: true }, { name: "Sign off" }] },
    { key: "quotation", name: "Quotation" },
    { key: "handover", name: "Handover" }
  ]
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  org = await Organisation.create({ name: "Gamma Studio", slug: "gamma" });
  p.admin = await mkUser("admin", "Admin");
  p.handler = await mkUser("user", "Handler");
  p.lead = await mkUser("user", "Lead");
  p.outsider = await mkUser("user", "Outsider");
  p.customer = await mkUser("customer", "Customer");
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const mkProject = (project) =>
  inOrg(() =>
    Conversation.create({
      type: "group",
      name: "Project",
      createdBy: p.admin._id,
      members: [
        { user: p.customer._id, role: "member" },
        { user: p.lead._id, role: "admin" }
      ],
      project: { status: "active", customers: [p.customer._id], leadDesigner: p.lead._id, createdBy: p.admin._id, ...project }
    })
  );

describe("workflow editor", () => {
  let legacy;

  test("starts on the Basic workflow; admins may edit everything", async () => {
    legacy = await mkProject({ stage: "site_measurement" }); // from before workflows: no flow stored
    const s = await state();
    expect(s.version).toBe(1);
    expect(s.canEdit).toBe("all");
    expect(s.draft).toBeNull();
    expect(s.preview.stages).toHaveLength(7);
  });

  test("an admin restructures and publishes v2; handlers and departments must exist", async () => {
    expect(await code(save(p.admin, V2("64b7f0c2a1b2c3d4e5f60718")).then(() => publish(p.admin)))).toBe("UNKNOWN_HANDLER");
    await save(p.admin, V2(String(p.handler._id)));
    const out = await publish(p.admin);
    expect(out.version).toBe(2);
    expect(out.summary.removed.map((r) => r.key).sort()).toEqual(["installation", "production", "site_measurement"]);
    expect(out.projectsOnOlderVersions).toBe(1); // the older project stays on v1 (W6)
    expect((await state()).draft).toBeNull();
  });

  test("two editors can't overwrite each other's draft", async () => {
    const s = await state();
    await inOrg(() => editor.saveDraft(p.admin, { tree: s.tree, revision: s.draftRevision }));
    expect(await code(inOrg(() => editor.saveDraft(p.admin, { tree: s.tree, revision: s.draftRevision })))).toBe("DRAFT_CHANGED");
    await inOrg(async () => editor.discardDraft(p.admin, { revision: (await editor.editorState(p.admin)).draftRevision }));
  });

  test("a stage handler may change their own stage and publish it straight away; admins are told (C1)", async () => {
    const s = await state();
    expect((await inOrg(() => editor.editorState(p.handler))).canEdit).toEqual(["design"]);
    const tree = JSON.parse(JSON.stringify(s.tree));
    tree.stages[1].subStages.splice(1, 0, { name: "3D renders", showToCustomer: true });
    await save(p.handler, tree);
    const out = await publish(p.handler);
    expect(out.version).toBe(3);
    expect(await inOrg(() => Notification.countDocuments({ recipient: p.admin._id, title: /v3 published/ }))).toBe(1);
  });

  test("…but not other stages, the stage list, or who handles a stage", async () => {
    const base = (await state()).tree;
    const otherStage = JSON.parse(JSON.stringify(base));
    otherStage.stages[2].name = "Pricing";
    expect(await code(save(p.handler, otherStage))).toBe("NOT_YOUR_STAGE");
    const addStage = JSON.parse(JSON.stringify(base));
    addStage.stages.push({ name: "Aftercare" });
    expect(await code(save(p.handler, addStage))).toBe("ADMIN_ONLY_CHANGE");
    const selfPromote = JSON.parse(JSON.stringify(base));
    selfPromote.stages[2].handlers = [String(p.handler._id)];
    expect(await code(save(p.handler, selfPromote))).toBe("ADMIN_ONLY_CHANGE");
    expect(await code(save(p.outsider, base))).toBe("NOT_STAGE_HANDLER");
  });

  test("running projects move to the newest version with a mapping for removed steps (W6)", async () => {
    // A v2 project at the redesign step (activated) and the older project still on v1
    const v2 = await inOrg(() => require("../src/modules/workflows/models/WorkflowVersion").findOne({ version: 2 }).lean());
    const onV2 = await mkProject({ stage: "design", flow: { versionId: v2._id, version: 2, stepKey: "design/concept", activated: [{ key: "design/redesign", at: new Date() }] } });

    const plan = await inOrg(() => editor.migrationPlan(1));
    expect(plan.removed.map((r) => r.key).sort()).toEqual(["installation", "production", "site_measurement"]);
    expect(await code(inOrg(() => editor.migrate(p.admin, { fromVersion: 1 })))).toBe("MAPPING_REQUIRED");

    const r1 = await inOrg(() => editor.migrate(p.admin, { fromVersion: 1, mapping: { site_measurement: "design/concept", production: "quotation", installation: "handover" } }));
    expect(r1.moved).toBe(1);
    const old = await Conversation.collection.findOne({ _id: legacy._id });
    expect(old.project.flow.version).toBe(3);
    expect(old.project.flow.stepKey).toBe("design/concept");
    expect(old.project.stageHistory.at(-1)).toMatchObject({ kind: "migrate", from: "site_measurement", step: "design/concept" });

    const r2 = await inOrg(() => editor.migrate(p.handler, { fromVersion: 2 })); // only design changed: the handler may
    expect(r2.moved).toBe(1);
    const moved = await Conversation.collection.findOne({ _id: onV2._id });
    expect(moved.project.flow.version).toBe(3);
    expect(moved.project.flow.activated.map((a) => a.key)).toEqual(["design/redesign"]); // still exists in v3

    // After moving, the project follows v3 (3D renders now comes after concept)
    const v = await inOrg(() => flow.move({ conversationId: onV2._id, actor: p.lead, to: "design/s_3d_renders", from: "design/concept" }));
    expect(v.flow.stepKey).toBe("design/s_3d_renders");
  });

  test("version history lists versions with project counts", async () => {
    const list = await inOrg(() => editor.versions());
    expect(list.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(list[0].projects).toBe(2);
    inOrg(() => workflows.invalidate());
  });
});
