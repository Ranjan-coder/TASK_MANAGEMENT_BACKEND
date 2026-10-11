/**
 * The product owner's standard departments and designations:
 * - a company's own change stays inside that company
 * - a product-owner change reaches every company, except fields a company changed
 * - a new standard item is added to every company (and a deleted copy doesn't come back)
 * - "Reset to standard", name clashes, and new companies starting from the current list
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";

const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const Department = require("../src/models/Department");
const { TemplateDepartment } = require("../src/models/OrgTemplate");
const { newSalt, deriveAuthKey } = require("../src/utils/kdf");

jest.setTimeout(180000);

const PASSWORD = "Sample-Pass1";
let mongod;
let app;
const orgs = {};
const cookies = {};

const makeUser = (orgId, fields) => {
  const run = orgId ? (fn) => tenant.runInOrg(orgId, fn) : tenant.runAsPlatform;
  return run(async () => {
    const salt = newSalt();
    const u = new User({ name: "Person", status: "active", ...fields });
    u.setDerivedCredential(deriveAuthKey(PASSWORD, salt), salt);
    return u.save();
  });
};

const login = async (email, organisation) => {
  const pre = await request(app).post("/api/v1/auth/prelogin").send({ identifier: email, organisation });
  const res = await request(app).post("/api/v1/auth/login").send({ identifier: email, organisation, authKey: deriveAuthKey(PASSWORD, pre.body.data.kdf.salt) });
  expect(res.status).toBe(200);
  return res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
};

const owner = (method, url) => request(app)[method](`/api/v1/platform/org-template${url}`).set("Cookie", cookies.owner);
const as = (who, method, url) => request(app)[method](`/api/v1/org${url}`).set("Cookie", cookies[who]);
const depts = async (who) => (await as(who, "get", "/departments?includeInactive=1")).body.data;
const desigs = async (who) => (await as(who, "get", "/designations?includeInactive=1")).body.data.items;
const find = (list, name) => list.find((x) => x.name === name);
const tplDept = async (name) => (await owner("get", "")).body.data.departments.find((d) => d.name === name);
const tplDesig = async (name) => (await owner("get", "")).body.data.designations.find((d) => d.name === name);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  app = require("../src/app");

  orgs.alpha = await Organisation.create({ name: "Alpha", slug: "alpha", modules: [] });
  orgs.beta = await Organisation.create({ name: "Beta", slug: "beta", modules: [] });
  await makeUser(orgs.alpha._id, { email: "boss@alpha.test", role: "superadmin" });
  await makeUser(orgs.beta._id, { email: "boss@beta.test", role: "superadmin" });
  await makeUser(null, { email: "owner@platform.test", role: "platform_owner" });
  cookies.alpha = await login("boss@alpha.test", "alpha");
  cookies.beta = await login("boss@beta.test", "beta");
  cookies.owner = await login("owner@platform.test", "platform");

  // Both companies open their lists (seeded from the standard list)
  await depts("alpha");
  await depts("beta");
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("standard list", () => {
  test("the product owner sees the standard list with how many companies use each item", async () => {
    const res = await owner("get", "");
    expect(res.status).toBe(200);
    const sales = find(res.body.data.departments, "Sales");
    expect(sales).toMatchObject({ companies: 2, customised: 0 });
    expect(find(res.body.data.designations, "General Manager")).toMatchObject({ level: 4, companies: 2 });
    // Companies' items say they are standard
    expect(find(await depts("alpha"), "Sales")).toMatchObject({ standard: true, customised: [] });
  });

  test("a company's own change stays inside that company", async () => {
    const hr = find(await depts("alpha"), "HR");
    expect((await as("alpha", "patch", `/departments/${hr._id}`).send({ name: "People Team" })).status).toBe(200);
    expect(find(await depts("alpha"), "People Team")).toMatchObject({ standard: true, customised: ["name"] });
    expect(find(await depts("beta"), "HR")).toBeTruthy();
    expect(find(await depts("beta"), "People Team")).toBeUndefined();
    expect((await tplDept("HR")).customised).toBe(1);
  });

  test("a product-owner change reaches every company, except fields a company changed", async () => {
    const hr = await tplDept("HR");
    const res = await owner("patch", `/departments/${hr._id}`).send({ name: "Human Resources", description: "Hiring and people" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ companies: 2, kept: 1 });
    // Beta: both fields; Alpha: kept its own name, took the description
    expect(find(await depts("beta"), "Human Resources")).toMatchObject({ description: "Hiring and people" });
    expect(find(await depts("alpha"), "People Team")).toMatchObject({ description: "Hiring and people" });
  });

  test("a rename also renames everyone's copy of the name", async () => {
    const sales = find(await depts("beta"), "Sales");
    const person = await makeUser(orgs.beta._id, { email: "seller@beta.test", role: "user", departmentId: sales._id, department: "Sales" });
    await owner("patch", `/departments/${(await tplDept("Sales"))._id}`).send({ name: "Sales Team" });
    const fresh = await tenant.runInOrg(orgs.beta._id, () => User.findById(person._id).select("department").lean());
    expect(fresh.department).toBe("Sales Team");
  });

  test("a designation level change reaches companies that didn't change it", async () => {
    const gm = find(await desigs("alpha"), "General Manager");
    await as("alpha", "patch", `/designations/${gm._id}`).send({ level: 3 });
    const res = await owner("patch", `/designations/${(await tplDesig("General Manager"))._id}`).send({ level: 5, short: "G.M." });
    expect(res.body.data).toMatchObject({ companies: 2, kept: 1 });
    expect(find(await desigs("beta"), "General Manager")).toMatchObject({ level: 5, short: "G.M." });
    expect(find(await desigs("alpha"), "General Manager")).toMatchObject({ level: 3, short: "G.M." });
  });

  test("a new standard item is added to every company, linked to each company's own departments", async () => {
    const dept = await owner("post", "/departments").send({ name: "Interiors Lab" });
    expect(dept.status).toBe(201);
    expect(dept.body.data.companies).toBe(2);
    const desig = await owner("post", "/designations").send({ name: "Lab Lead", short: "LL", level: 6, departments: [dept.body.data.item._id] });
    expect(desig.status).toBe(201);
    for (const who of ["alpha", "beta"]) {
      const lab = find(await depts(who), "Interiors Lab");
      expect(lab).toMatchObject({ standard: true });
      expect(find(await desigs(who), "Lab Lead")).toMatchObject({ level: 6, departments: [lab._id], standard: true });
    }
  });

  test("a company that deletes a standard item doesn't get it back", async () => {
    const lead = find(await desigs("alpha"), "Lab Lead");
    expect((await as("alpha", "delete", `/designations/${lead._id}`)).status).toBe(200);
    await owner("patch", `/designations/${(await tplDesig("Lab Lead"))._id}`).send({ level: 7 });
    expect(find(await desigs("alpha"), "Lab Lead")).toBeUndefined();
    expect(find(await desigs("beta"), "Lab Lead")).toMatchObject({ level: 7 });
  });

  test("a rename that clashes with a company's own name leaves that company's item as it was", async () => {
    await as("beta", "post", "/departments").send({ name: "Growth" });
    const bd = await tplDept("Business Development");
    const res = await owner("patch", `/departments/${bd._id}`).send({ name: "Growth" });
    expect(res.status).toBe(200);
    expect(find(await depts("alpha"), "Growth")).toMatchObject({ standard: true });
    expect(find(await depts("beta"), "Business Development")).toMatchObject({ standard: true, customised: ["name"] });
    expect((await depts("beta")).filter((d) => d.name === "Growth")).toHaveLength(1);
  });

  test("Reset to standard takes the product owner's version again", async () => {
    const mine = find(await depts("alpha"), "People Team");
    const res = await as("alpha", "post", `/departments/${mine._id}/reset`);
    expect(res.status).toBe(200);
    expect(find(await depts("alpha"), "Human Resources")).toMatchObject({ customised: [] });
    // From now on product-owner renames reach it again
    await owner("patch", `/departments/${(await tplDept("Human Resources"))._id}`).send({ name: "People & Culture" });
    expect(find(await depts("alpha"), "People & Culture")).toBeTruthy();
    // A company's own item can't be reset
    const growth = find(await depts("beta"), "Growth");
    expect((await as("beta", "post", `/departments/${growth._id}/reset`)).status).toBe(400);
  });

  test("deactivating a standard item reaches every company", async () => {
    await owner("patch", `/departments/${(await tplDept("Referral"))._id}`).send({ isActive: false });
    expect(find(await depts("alpha"), "Referral").isActive).toBe(false);
    expect(find(await depts("beta"), "Referral").isActive).toBe(false);
  });

  test("a new company starts from the current standard list", async () => {
    const gamma = await Organisation.create({ name: "Gamma", slug: "gamma", modules: [] });
    await makeUser(gamma._id, { email: "boss@gamma.test", role: "superadmin" });
    cookies.gamma = await login("boss@gamma.test", "gamma");
    const list = await depts("gamma");
    const names = list.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["Sales Team", "Interiors Lab", "People & Culture", "Growth"]));
    expect(names).not.toContain("Referral"); // inactive standard items aren't copied
    expect(find(await desigs("gamma"), "Lab Lead")).toMatchObject({ level: 7, departments: [find(list, "Interiors Lab")._id] });
  });

  test("companies can't change the standard list", async () => {
    expect((await request(app).get("/api/v1/platform/org-template").set("Cookie", cookies.alpha)).status).toBe(403);
    expect((await request(app).post("/api/v1/platform/org-template/departments").set("Cookie", cookies.alpha).send({ name: "Sneaky" })).status).toBe(403);
  });

  test("removing an item from the standard list keeps companies' copies as their own", async () => {
    const lab = await tplDept("Interiors Lab");
    const res = await owner("delete", `/departments/${lab._id}`);
    expect(res.body.data.detached).toBe(3);
    expect(find(await depts("alpha"), "Interiors Lab")).toMatchObject({ standard: false });
    expect(await TemplateDepartment.countDocuments({ name: "Interiors Lab" })).toBe(0);
  });
});

describe("linking companies that existed before the standard list", () => {
  test("items with the same name are linked; differences are kept as the company's own", async () => {
    const { linkExisting } = require("../src/services/orgTemplate.service");
    const delta = await Organisation.create({ name: "Delta", slug: "delta", modules: [] });
    await tenant.runInOrg(delta._id, () =>
      Department.insertMany([
        { name: "Sales Team", key: "salesteam", description: "Our own words" },
        { name: "Kitchens", key: "kitchens" }
      ])
    );
    await linkExisting();
    const rows = await tenant.runInOrg(delta._id, () => Department.find().lean());
    const sales = rows.find((r) => r.name === "Sales Team");
    expect(String(sales.templateId)).toBe(String((await TemplateDepartment.findOne({ key: "salesteam" }))._id));
    expect(sales.overrides).toEqual(["description"]);
    expect(rows.find((r) => r.name === "Kitchens").templateId).toBeNull();
  });
});
