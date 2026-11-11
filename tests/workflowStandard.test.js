/**
 * Standard workflows (product owner) and how they reach companies, against a real
 * MongoDB (in-memory): the default for new companies (W1) and updates that are
 * offered, merged into a draft and published by the company's admin (W7).
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const templates = require("../src/modules/workflows/template.service");
const editor = require("../src/modules/workflows/editor.service");
const workflows = require("../src/modules/workflows/workflow.service");

jest.setTimeout(120000);

let mongod;
let owner;
const code = async (p) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err.errors?.[0]?.code || err.message;
  }
};
const company = async (slug) => {
  const org = await Organisation.create({ name: slug, slug });
  const admin = await tenant.runInOrg(org._id, () => User.create({ name: "Admin", email: `admin@${slug}.com`, role: "admin", password: "x".repeat(60) }));
  const inOrg = (fn) => tenant.runInOrg(org._id, fn);
  return { org, admin, inOrg };
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  owner = { _id: new mongoose.Types.ObjectId(), role: "platform_owner", name: "Owner" };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("standard workflows", () => {
  let basic;
  let early;

  test("the Basic workflow exists and is the default; an early company starts from it", async () => {
    early = await company("early");
    const s = await early.inOrg(() => editor.editorState(early.admin));
    expect(s.tree.stages).toHaveLength(7);
    const list = await templates.listTemplates();
    basic = list.find((t) => t.defaultForNewCompanies);
    expect(basic.name).toBe("Basic workflow");
    expect(basic.companies).toBe(1);
  });

  test("the product owner makes a new standard (a draft until published) and sets it as the default", async () => {
    const t = await templates.createTemplate(owner, { name: "Modular kitchen", copyOf: String(basic._id) });
    expect(t.currentVersion).toBe(0);
    expect(await code(templates.setDefault(owner, t._id))).toBe("NOT_PUBLISHED");
    const tree = { stages: [{ name: "Consultation", handlers: ["64b7f0c2a1b2c3d4e5f60718"] }, { name: "Kitchen design", subStages: [{ name: "Layout" }, { name: "Finish selection" }] }, { name: "Installation" }] };
    const d = await templates.saveTemplateDraft(owner, t._id, { tree, revision: t.draftRevision });
    expect(d.draft.stages[0].handlers).toEqual([]); // standards are company-neutral
    const p = await templates.publishTemplate(owner, t._id, { revision: d.draftRevision });
    expect(p.version).toBe(1);
    const list = await templates.setDefault(owner, t._id);
    expect(list.filter((x) => x.defaultForNewCompanies).map((x) => x.name)).toEqual(["Modular kitchen"]);
  });

  test("a company created now starts from the new default (W1)", async () => {
    const later = await company("later");
    const c = await later.inOrg(() => workflows.currentCompiled());
    expect(c.stages.map((s) => s.name)).toEqual(["Consultation", "Kitchen design", "Installation"]);
  });

  test("a new Basic version is offered to the company that started from it, never pushed (W7)", async () => {
    // The company makes its own change first
    let s = await early.inOrg(() => editor.editorState(early.admin));
    const ours = JSON.parse(JSON.stringify(s.tree));
    ours.stages[0].customerName = "First meeting";
    ours.stages[3].name = "Estimate";
    let d = await early.inOrg(() => editor.saveDraft(early.admin, { tree: ours, revision: s.draftRevision }));
    await early.inOrg(() => editor.publish(early.admin, { revision: d.draftRevision }));

    // The product owner updates Basic: a duration on Quotation, a rename of it, a new Aftercare stage
    const t = await templates.getTemplate(basic._id);
    const theirs = JSON.parse(JSON.stringify(t.tree));
    theirs.stages[3].durationDays = 5;
    theirs.stages[3].name = "Pricing";
    theirs.stages.push({ name: "Aftercare", subStages: [] });
    const td = await templates.saveTemplateDraft(owner, basic._id, { tree: theirs, revision: t.draftRevision });
    await templates.publishTemplate(owner, basic._id, { revision: td.draftRevision });

    s = await early.inOrg(() => editor.editorState(early.admin));
    expect(s.version).toBe(2); // nothing changed for the company yet
    expect(s.offer).toMatchObject({ templateName: "Basic workflow", fromVersion: 1, toVersion: 2 });

    const merged = await early.inOrg(() => editor.applyOffer(early.admin));
    expect(merged.conflicts).toEqual([expect.objectContaining({ stageKey: "quotation", field: "name", ours: "Estimate", theirs: "Pricing" })]);
    const q = merged.draft.stages.find((x) => x.key === "quotation");
    expect(q.name).toBe("Estimate"); // the company's edit wins
    expect(q.durationDays).toBe(5); // untouched by the company: taken
    expect(merged.draft.stages[0].customerName).toBe("First meeting");
    expect(merged.draft.stages.at(-1).name).toBe("Aftercare");

    await early.inOrg(() => editor.publish(early.admin, { revision: merged.draftRevision }));
    s = await early.inOrg(() => editor.editorState(early.admin));
    expect(s.version).toBe(3);
    expect(s.offer).toBeNull(); // taken
    const versions = await early.inOrg(() => editor.versions());
    expect(versions[0].source).toBe("update");
  });

  test("an admin can dismiss an update; staff can't take one", async () => {
    const t = await templates.getTemplate(basic._id);
    const theirs = JSON.parse(JSON.stringify(t.tree));
    theirs.stages[0].description = "Meet the customer at home";
    const td = await templates.saveTemplateDraft(owner, basic._id, { tree: theirs, revision: t.draftRevision });
    await templates.publishTemplate(owner, basic._id, { revision: td.draftRevision });

    const staff = await early.inOrg(() => User.create({ name: "Staff", email: "staff@early.com", role: "user", password: "x".repeat(60) }));
    expect(await code(early.inOrg(() => editor.applyOffer(staff)))).toBe("ADMIN_ONLY_CHANGE");
    expect((await early.inOrg(() => editor.dismissOffer(early.admin))).version).toBe(3);
    expect((await early.inOrg(() => editor.editorState(early.admin))).offer).toBeNull();
  });

  test("the default can't be archived", async () => {
    const list = await templates.listTemplates();
    const def = list.find((x) => x.defaultForNewCompanies);
    expect(await code(templates.updateTemplate(owner, def._id, { archived: true }))).toBe("DEFAULT_CANT_ARCHIVE");
  });
});
