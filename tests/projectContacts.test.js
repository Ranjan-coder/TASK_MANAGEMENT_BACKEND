/**
 * Project contacts (project-contacts-plan.md): the layered merge, validation,
 * and the service against a real (in-memory) MongoDB — who may read and edit,
 * staff who left falling back to the company default, and edit conflicts.
 */
process.env.NODE_ENV = "test";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const Conversation = require("../src/models/Conversation");
const v = require("../src/validators/phase8.validator");
const svc = require("../src/services/projectContacts.service");
const { mergeContacts, contactKey } = svc._internals;

jest.setTimeout(120000);

// ── Pure merge ────────────────────────────────────────────────────────────────

describe("merging the three layers", () => {
  const people = new Map(["lead", "pm", "priya", "ravi"].map((id) => [id, { _id: id, name: id }]));
  const layers = {
    builtIn: [{ topic: "design", user: "lead" }, { topic: "site", user: "pm" }],
    company: [{ topic: "payments", user: "priya", phone: "+919876543210", whatsapp: true }, { topic: "site", user: "ravi", phone: "+919800000000" }],
    project: [{ topic: "custom", label: "Furniture delivery", user: "ravi" }, { topic: "site", user: "pm", phone: "+919811111111" }]
  };

  test("later layers replace earlier ones topic by topic; order is fixed; sources are kept", () => {
    const out = mergeContacts(layers, people, new Set(["lead", "pm"]));
    expect(out.map((c) => [c.topic, c.person._id, c.source])).toEqual([
      ["design", "lead", "team"],
      ["site", "pm", "project"],
      ["payments", "priya", "company"],
      ["custom", "ravi", "project"]
    ]);
    expect(out.find((c) => c.topic === "site").phone).toBe("+919811111111");
    expect(out.find((c) => c.topic === "custom").label).toBe("Furniture delivery");
    expect(out.find((c) => c.topic === "design").label).toBe("Design questions");
    // "Ask in chat" only for chat members; built-in contacts show no phone (P3)
    expect(out.map((c) => c.inChat)).toEqual([true, true, false, false]);
    expect(out[0].phone).toBe("");
  });

  test("someone who left is skipped, so the layer below shows (never a dead contact)", () => {
    const gone = new Map([...people].filter(([id]) => id !== "pm"));
    const site = mergeContacts(layers, gone).find((c) => c.topic === "site");
    expect(site.person._id).toBe("ravi"); // the company default takes over
    expect(mergeContacts({ builtIn: [{ topic: "design", user: "x" }], company: [], project: [] }, people)).toEqual([]);
  });

  test("custom topics are told apart by label, case-insensitively", () => {
    expect(contactKey({ topic: "custom", label: " Furniture Delivery " })).toBe(contactKey({ topic: "custom", label: "furniture delivery" }));
    expect(contactKey({ topic: "design", label: "anything" })).toBe("design");
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("validation", () => {
  const U = "64b7f0c2a1b2c3d4e5f60711";
  const parse = (contacts, rev = 0) => v.companyContactsSchema.parse({ body: { contacts, rev } }).body.contacts;
  test("phones are normalised; WhatsApp needs a mobile; emails and custom labels are checked; unknown fields refused", () => {
    expect(parse([{ topic: "site", user: U, phone: "98765 43210", whatsapp: true }])[0]).toMatchObject({ phone: "+919876543210", whatsapp: true });
    expect(parse([{ topic: "payments", user: U, phone: "1800-123-4567" }])[0].phone).toBe("18001234567");
    expect(() => parse([{ topic: "payments", user: U, phone: "1800-123-4567", whatsapp: true }])).toThrow(/WhatsApp/);
    expect(() => parse([{ topic: "site", user: U, phone: "12" }])).toThrow(/phone/);
    expect(() => parse([{ topic: "site", user: U, email: "not-an-email" }])).toThrow(/email/);
    expect(() => parse([{ topic: "custom", user: U }])).toThrow(/Name the topic/);
    expect(() => parse([{ topic: "site", user: U, link: "https://x" }])).toThrow();
    expect(() => parse([{ topic: "boss", user: U }])).toThrow();
    expect(() => parse(Array.from({ length: 9 }, () => ({ topic: "site", user: U })))).toThrow(/Up to 8/);
    expect(parse([{ topic: "general", user: U, hours: "Mon–Sat\u0000 10–7", email: "PRIYA@Acme.test" }])[0]).toMatchObject({ hours: "Mon–Sat 10–7", email: "priya@acme.test" });
  });

  test("staff search parses as the validate middleware sends it (regression: the company route has params {})", () => {
    const req = (params, query) => ({ body: {}, params, query });
    expect(() => v.companyCandidatesSchema.parse(req({}, { search: "Asha" }))).not.toThrow();
    expect(() => v.companyCandidatesSchema.parse(req({}, {}))).not.toThrow();
    expect(() => v.contactCandidatesSchema.parse(req({ id: U }, { search: "Asha" }))).not.toThrow();
    expect(() => v.contactCandidatesSchema.parse(req({}, {}))).toThrow();
    expect(() => v.companyCandidatesSchema.parse(req({}, { search: "a", role: "customer" }))).toThrow(); // no extra filters
  });
});

// ── Service against MongoDB ───────────────────────────────────────────────────

describe("service", () => {
  let mongod;
  let org;
  const p = {};
  let projectId;
  let otherProjectId;
  const inOrg = (fn) => tenant.runInOrg(org._id, fn);

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { autoIndex: true });
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    org = await Organisation.create({ name: "Acme", slug: "acme" });
    const { newSalt, deriveAuthKey } = require("../src/utils/kdf");
    const make = (key, role, fields = {}) =>
      inOrg(async () => {
        const u = new User({ name: key, email: `${key}@acme.test`, role, status: "active", ...(role === "customer" && { phoneVerified: true }), ...fields });
        const salt = newSalt();
        u.setDerivedCredential(deriveAuthKey("Sample-Pass1", salt), salt);
        p[key] = await u.save();
      });
    await make("admin", "admin");
    await make("lead", "user");
    await make("pm", "user");
    await make("priya", "user", { phone: "+919876543210" });
    await make("staff", "user");
    await make("cust", "customer", { phone: "+919811111111" });
    await make("stranger", "customer", { phone: "+919822222222" });
    const project = (name, customer) =>
      inOrg(() =>
        Conversation.create({
          type: "group",
          name,
          createdBy: p.admin._id,
          members: [{ user: p.lead._id }, { user: p.pm._id }, { user: customer._id }],
          project: { status: "active", customers: [customer._id], leadDesigner: p.lead._id, manager: p.pm._id, createdBy: p.admin._id }
        })
      );
    projectId = String((await project("Rao Villa", p.cust))._id);
    otherProjectId = String((await project("Other Villa", p.stranger))._id);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  test("with nothing set up, the customer still sees the lead designer and project manager (chat only)", async () => {
    const view = await inOrg(() => svc.getProjectContacts(projectId, p.cust));
    expect(view.contacts.map((c) => [c.topic, c.person.name, c.inChat, c.phone])).toEqual([
      ["design", "lead", true, ""],
      ["site", "pm", true, ""]
    ]);
    expect(view.editable).toBeUndefined(); // customers never get the raw list
  });

  test("company defaults apply to every project; the project manager can override per project; customers see the result", async () => {
    await inOrg(() => svc.setCompanyContacts({ actor: p.admin, rev: 0, contacts: [{ topic: "payments", user: String(p.priya._id), phone: "+919876543210", whatsapp: true }] }));
    const pmView = await inOrg(() => svc.getProjectContacts(projectId, p.pm));
    expect(pmView.editable.rev).toBe(0);
    await inOrg(() => svc.setProjectContacts({ conversationId: projectId, actor: p.pm, rev: 0, contacts: [{ topic: "site", user: String(p.pm._id), phone: "+919800000000", hours: "10–7" }] }));

    const cust = await inOrg(() => svc.getProjectContacts(projectId, p.cust));
    expect(cust.contacts.map((c) => [c.topic, c.person.name, c.source])).toEqual([
      ["design", "lead", "team"],
      ["site", "pm", "project"],
      ["payments", "priya", "company"]
    ]);
    expect(cust.contacts[1]).toMatchObject({ phone: "+919800000000", hours: "10–7" });
    expect(cust.contacts[2]).toMatchObject({ whatsapp: true, inChat: false });
    // The other project gets the company default too, not this project's override
    const other = await inOrg(() => svc.getProjectContacts(otherProjectId, p.stranger));
    expect(other.contacts.find((c) => c.topic === "site").phone).toBe("");
  });

  test("two editors can't overwrite each other (revision check)", async () => {
    // The PM saved revision 0 → 1 above; an editor still holding revision 0 is refused
    await expect(inOrg(() => svc.setProjectContacts({ conversationId: projectId, actor: p.admin, rev: 0, contacts: [] }))).rejects.toMatchObject({ statusCode: 409 });
    const fresh = await inOrg(() => svc.getProjectContacts(projectId, p.admin));
    expect(fresh.editable.rev).toBe(1);
    await expect(inOrg(() => svc.setCompanyContacts({ actor: p.admin, rev: 0, contacts: [] }))).rejects.toMatchObject({ statusCode: 409 });
  });

  test("only admins and the project's manager edit; only members (and admins) read", async () => {
    await expect(inOrg(() => svc.setProjectContacts({ conversationId: projectId, actor: p.lead, rev: 1, contacts: [] }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(inOrg(() => svc.projectCandidates(projectId, p.staff))).rejects.toMatchObject({ statusCode: 403 });
    await expect(inOrg(() => svc.getProjectContacts(projectId, p.stranger))).rejects.toMatchObject({ statusCode: 403 });
    await expect(inOrg(() => svc.getProjectContacts(projectId, p.staff))).rejects.toMatchObject({ statusCode: 403 });
    expect((await inOrg(() => svc.getProjectContacts(projectId, p.admin))).contacts.length).toBe(3);
    // Customers can't be named as contacts; nor can the same topic appear twice
    await expect(inOrg(() => svc.setProjectContacts({ conversationId: projectId, actor: p.admin, rev: 1, contacts: [{ topic: "general", user: String(p.cust._id) }] }))).rejects.toThrow(/active staff/);
    await expect(
      inOrg(() => svc.setProjectContacts({ conversationId: projectId, actor: p.admin, rev: 1, contacts: [{ topic: "site", user: String(p.pm._id) }, { topic: "site", user: String(p.lead._id) }] }))
    ).rejects.toThrow(/twice/);
  });

  test("a contact who is suspended disappears and the company default takes over; candidates carry profile phone for prefilling", async () => {
    await inOrg(() => svc.setCompanyContacts({ actor: p.admin, rev: 1, contacts: [{ topic: "site", user: String(p.priya._id), phone: "+919876543210" }] }));
    await inOrg(() => User.updateOne({ _id: p.pm._id }, { status: "suspended" }));
    const site = (await inOrg(() => svc.getProjectContacts(projectId, p.cust))).contacts.find((c) => c.topic === "site");
    expect(site).toMatchObject({ source: "company", phone: "+919876543210" });
    expect(site.person.name).toBe("priya");

    const found = await inOrg(() => svc.candidates("pri"));
    expect(found).toEqual([expect.objectContaining({ name: "priya", phone: "+919876543210", email: "priya@acme.test" })]);
    expect((await inOrg(() => svc.candidates(""))).some((c) => c.name === "cust")).toBe(false); // staff only
  });

  test("customer Home: contacts for every project in one batch", async () => {
    const map = await inOrg(async () => svc.contactsForMany(await Conversation.find({ _id: { $in: [projectId, otherProjectId] } }).lean()));
    expect([...map.keys()].sort()).toEqual([projectId, otherProjectId].sort());
    expect(map.get(otherProjectId).find((c) => c.topic === "site").person.name).toBe("priya");
  });
});
