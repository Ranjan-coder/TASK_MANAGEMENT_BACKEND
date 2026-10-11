/**
 * Departments and designations over HTTP: a superadmin creates a department, then
 * designations linked to it with a level; admins can't change the lists; the
 * lists are per organisation.
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";

const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const { newSalt, deriveAuthKey } = require("../src/utils/kdf");

jest.setTimeout(120000);

const PASSWORD = "Sample-Pass1";
let mongod;
let app;
const cookies = {};
const ids = {};

const makeUser = (orgId, fields) =>
  tenant.runInOrg(orgId, async () => {
    const salt = newSalt();
    const u = new User({ name: "Person", status: "active", ...fields });
    u.setDerivedCredential(deriveAuthKey(PASSWORD, salt), salt);
    return u.save();
  });

const login = async (email) => {
  const organisation = email.split("@")[1].split(".")[0];
  const pre = await request(app).post("/api/v1/auth/prelogin").send({ identifier: email, organisation });
  const res = await request(app).post("/api/v1/auth/login").send({ identifier: email, organisation, authKey: deriveAuthKey(PASSWORD, pre.body.data.kdf.salt) });
  expect(res.status).toBe(200);
  return res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
};

const as = (who, method, url) => request(app)[method](`/api/v1/org${url}`).set("Cookie", cookies[who]);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  app = require("../src/app");

  const alpha = await Organisation.create({ name: "Alpha", slug: "alpha", modules: [] });
  const beta = await Organisation.create({ name: "Beta", slug: "beta", modules: [] });
  await makeUser(alpha._id, { email: "boss@alpha.test", role: "superadmin" });
  await makeUser(alpha._id, { email: "admin@alpha.test", role: "admin" });
  await makeUser(beta._id, { email: "boss@beta.test", role: "superadmin" });
  ids.lead = String((await makeUser(alpha._id, { email: "lead@alpha.test", name: "Lead Person", role: "user" }))._id);
  ids.cust = String((await makeUser(alpha._id, { email: "cust@alpha.test", name: "Cust Person", role: "customer" }))._id);
  ids.betaStaff = String((await makeUser(beta._id, { email: "staff@beta.test", name: "Beta Staff", role: "user" }))._id);
  cookies.boss = await login("boss@alpha.test");
  cookies.admin = await login("admin@alpha.test");
  cookies.beta = await login("boss@beta.test");
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("departments and designations", () => {
  let deptId;

  test("a superadmin creates a department, then a designation in it with a level", async () => {
    const dept = await as("boss", "post", "/departments").send({ name: "Kitchen Studio" });
    expect(dept.status).toBe(201);
    deptId = dept.body.data._id;

    const title = await as("boss", "post", "/designations").send({ name: "Success Manager", short: "CSM", level: 6, departments: [deptId], suggestedRole: "user" });
    expect(title.status).toBe(201);
    expect(title.body.data).toMatchObject({ name: "Success Manager", short: "CSM", level: 6, departments: [deptId], suggestedRole: "user" });

    const list = await as("boss", "get", "/designations");
    const found = list.body.data.items.find((g) => g.name === "Success Manager");
    expect(found.departments).toEqual([deptId]);
  });

  test("the level can be changed, and only 1–9 is accepted", async () => {
    const list = await as("boss", "get", "/designations");
    const id = list.body.data.items.find((g) => g.name === "Success Manager")._id;
    expect((await as("boss", "patch", `/designations/${id}`).send({ level: 5 })).body.data.level).toBe(5);
    expect((await as("boss", "patch", `/designations/${id}`).send({ level: 10 })).status).toBe(400);
    expect((await as("boss", "post", "/designations").send({ name: "Bad Level", level: 0 })).status).toBe(400);
  });

  test("near-duplicate names and unknown departments are refused", async () => {
    expect((await as("boss", "post", "/departments").send({ name: "kitchen  studio" })).status).toBe(409);
    const ghost = new mongoose.Types.ObjectId().toString();
    expect((await as("boss", "post", "/designations").send({ name: "Ghost Lead", level: 7, departments: [ghost] })).status).toBe(400);
  });

  test("admins can see the lists but not change them", async () => {
    expect((await as("admin", "get", "/departments")).status).toBe(200);
    expect((await as("admin", "post", "/departments").send({ name: "Shadow Team" })).status).toBe(403);
    expect((await as("admin", "post", "/designations").send({ name: "Shadow Title", level: 8 })).status).toBe(403);
  });

  test("each organisation has its own lists", async () => {
    const names = (await as("beta", "get", "/departments")).body.data.map((d) => d.name);
    expect(names).not.toContain("Kitchen Studio");
    // Another organisation's department can't be linked
    expect((await as("beta", "post", "/designations").send({ name: "Beta Lead", level: 7, departments: [deptId] })).status).toBe(400);
  });

  test("a department head must be active staff of this organisation; description is saved", async () => {
    const res = await as("boss", "patch", `/departments/${deptId}`).send({ head: ids.lead, description: "Modular kitchens, design to install" });
    expect(res.status).toBe(200);
    const dept = (await as("boss", "get", "/departments")).body.data.find((d) => d._id === deptId);
    expect(dept.head).toMatchObject({ _id: ids.lead, name: "Lead Person" });
    expect(dept.description).toBe("Modular kitchens, design to install");

    expect((await as("boss", "patch", `/departments/${deptId}`).send({ head: ids.cust })).status).toBe(400);
    expect((await as("boss", "patch", `/departments/${deptId}`).send({ head: ids.betaStaff })).status).toBe(400);
    expect((await as("boss", "patch", `/departments/${deptId}`).send({ description: "x".repeat(301) })).status).toBe(400);
    expect((await as("admin", "patch", `/departments/${deptId}`).send({ head: null })).status).toBe(403);

    // Removing the head
    expect((await as("boss", "patch", `/departments/${deptId}`).send({ head: null })).status).toBe(200);
    expect((await as("boss", "get", "/departments")).body.data.find((d) => d._id === deptId).head).toBeNull();
  });
});
