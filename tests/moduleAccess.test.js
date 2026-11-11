/**
 * Phase 4 (module-access-plan.md): per-person module access and seats, against a
 * real (in-memory) MongoDB.
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";

const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const modules = require("../src/config/modules");
const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const SeatCounter = require("../src/models/SeatCounter");
const access = require("../src/services/moduleAccess.service");
const { invalidate } = require("../src/services/organisation.service");
const { newSalt, deriveAuthKey } = require("../src/utils/kdf");

jest.setTimeout(120000);

describe("who holds what (pure)", () => {
  const mask = (keys) => modules.toMask(keys);
  const org = modules.effectiveMask(mask(["tasks", "projects", "chat", "leads"]));

  test("defaults by role", () => {
    expect(access.userModuleMask({ role: "superadmin", moduleAccess: { all: false, keys: [] } })).toBe(modules.ALL_MASK);
    expect(access.userModuleMask({ role: "admin" })).toBe(modules.ALL_MASK);
    // On-by-default (Planner) and organisation-wide (branding) modules come on top of what was given
    const base = modules.CORE_MASK | modules.DEFAULT_ON_MASK | modules.ORG_WIDE_MASK;
    expect(access.userModuleMask({ role: "admin", moduleAccess: { all: false, keys: ["tasks"] } })).toBe(base | modules.BIT.tasks);
    expect(access.userModuleMask({ role: "user" })).toBe(base);
    // Customers: everything except staff-only modules, unless the organisation opened them
    expect(access.userModuleMask({ role: "customer" })).toBe(modules.ALL_MASK & ~modules.STAFF_ONLY_MASK);
    // Opening the planner to customers adds only the planner (other staff-only modules stay staff-only)
    expect(access.userModuleMask({ role: "customer" }, modules.BIT.planner)).toBe(modules.ALL_MASK & ~(modules.STAFF_ONLY_MASK & ~modules.BIT.planner));
    expect(access.userModuleMask({ role: "platform_owner" })).toBe(0);
  });

  test("a person needs both the organisation and their own grant, plus what the module requires", () => {
    const chatOnly = { role: "user", moduleAccess: { keys: ["chat"] } }; // projects missing
    expect(access.effectiveUserMask(chatOnly, org) & modules.BIT.chat).toBe(0);
    const withProjects = { role: "user", moduleAccess: { keys: ["chat", "projects"] } };
    expect(access.effectiveUserMask(withProjects, org) & modules.BIT.chat).not.toBe(0);
    const paymentsGrant = { role: "user", moduleAccess: { keys: ["payments", "projects"] } }; // org lacks payments
    expect(access.effectiveUserMask(paymentsGrant, org) & modules.BIT.payments).toBe(0);
  });

  test("choosing modules adds their requirements and refuses ones the organisation lacks", () => {
    expect(access.resolveKeys(["chat"], org).sort()).toEqual(["chat", "projects"]);
    expect(() => access.resolveKeys(["payments"], org)).toThrow(/doesn't have/);
    expect(() => access.resolveKeys(["core"], org)).toThrow(/Unknown module/);
  });

  test("only active staff take seats", () => {
    expect(access.seatMask({ role: "user", status: "active", moduleAccess: { keys: ["tasks"] } })).toBe(modules.BIT.tasks);
    expect(access.seatMask({ role: "user", status: "inactive", moduleAccess: { keys: ["tasks"] } })).toBe(0);
    expect(access.seatMask({ role: "customer", status: "active" })).toBe(0);
  });
});

describe("module access (HTTP)", () => {
  let mongod;
  let app;
  let org;
  const people = {};
  const cookies = {};
  const PASSWORD = "Sample-Pass1";

  const makeUser = (key, fields) =>
    tenant.runInOrg(org._id, async () => {
      const salt = newSalt();
      const u = new User({ name: key, email: `${key}@acme.test`, ...fields });
      u.setDerivedCredential(deriveAuthKey(PASSWORD, salt), salt);
      await access.transition(null, u, () => u.save());
      people[key] = u;
      return u;
    });
  const login = async (key) => {
    const identifier = `${key}@acme.test`;
    const pre = await request(app).post("/api/v1/auth/prelogin").send({ identifier, organisation: "acme" });
    const res = await request(app).post("/api/v1/auth/login").send({ identifier, organisation: "acme", authKey: deriveAuthKey(PASSWORD, pre.body.data.kdf.salt) });
    expect(res.status).toBe(200);
    cookies[key] = res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
  };
  const as = (key, method, url) => request(app)[method](`/api/v1${url}`).set("Cookie", cookies[key]);
  const seats = async (key) => (await tenant.runInOrg(org._id, () => SeatCounter.findOne({ module: key }).lean()))?.used || 0;
  const setLimit = async (key, seatLimit) => {
    await Organisation.updateOne({ _id: org._id, "modules.key": key }, { $set: { "modules.$.seatLimit": seatLimit } });
    invalidate(org._id);
  };
  const setOn = async (key, enabled) => {
    await Organisation.updateOne({ _id: org._id, "modules.key": key }, { $set: { "modules.$.enabled": enabled } });
    invalidate(org._id);
  };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { autoIndex: true });
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    app = require("../src/app");
    org = await Organisation.create({
      name: "Acme",
      slug: "acme",
      modules: ["tasks", "projects", "chat", "leads", "marketing"].map((key) => ({ key, enabled: true }))
    });
    await makeUser("boss", { role: "superadmin" });
    await makeUser("admin", { role: "admin" });
    await makeUser("u1", { role: "user" });
    await makeUser("u2", { role: "user" });
    await makeUser("mk", { role: "marketing" });
    for (const k of ["boss", "admin", "u1", "u2", "mk"]) await login(k);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod?.stop();
  });

  test("staff start with nothing but core; admins and superadmins hold everything", async () => {
    expect((await as("u1", "get", "/tasks")).body.errors[0]).toMatchObject({ code: "MODULE_NOT_GRANTED", module: "tasks" });
    expect((await as("u1", "get", "/notifications")).status).toBe(200);
    expect((await as("admin", "get", "/tasks")).status).toBe(200);
    expect(await seats("tasks")).toBe(2); // boss + admin
  });

  test("a superadmin gives a module; its requirements come with it; it works at once", async () => {
    const res = await as("boss", "patch", `/users/${people.u1._id}/modules`).send({ keys: ["chat"] });
    expect(res.status).toBe(200);
    expect(res.body.data.moduleAccess.keys.sort()).toEqual(["chat", "projects"]);
    expect((await as("u1", "get", "/chat/conversations")).status).toBe(200);
    const me = await as("u1", "get", "/auth/me");
    expect(me.body.data.modules).toEqual(expect.arrayContaining(["core", "chat", "projects"]));
    expect(me.body.data.modules).not.toContain("tasks");
    expect(await seats("chat")).toBe(3);
  });

  test("only a superadmin can give modules, and never to a customer or a superadmin", async () => {
    expect((await as("admin", "patch", `/users/${people.u2._id}/modules`).send({ keys: ["tasks"] })).status).toBe(403);
    expect((await as("boss", "patch", `/users/${people.boss._id}/modules`).send({ keys: [] })).status).toBe(400);
    expect((await as("boss", "patch", `/users/${people.u2._id}/modules`).send({ keys: ["payments"] })).status).toBe(400); // not in org
  });

  test("seat limits: full is refused, and two admins can't both take the last seat", async () => {
    await setLimit("leads", 2); // boss + admin already hold leads
    const full = await as("boss", "patch", `/users/${people.u1._id}/modules`).send({ keys: ["chat", "leads"] });
    expect(full.status).toBe(409);
    expect(full.body.errors[0]).toMatchObject({ code: "SEATS_FULL", module: "leads" });
    expect(await seats("leads")).toBe(2);

    await setLimit("leads", 3); // one seat left; two people at once
    const [a, b] = await Promise.all([
      as("boss", "patch", `/users/${people.u2._id}/modules`).send({ keys: ["leads"] }),
      as("boss", "patch", `/users/${people.mk._id}/modules`).send({ keys: ["leads"] })
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await seats("leads")).toBe(3);
  });

  test("a superadmin can take modules away from an admin (M4)", async () => {
    const res = await as("boss", "patch", `/users/${people.admin._id}/modules`).send({ all: false, keys: ["tasks"] });
    expect(res.status).toBe(200);
    expect((await as("admin", "get", "/admin/leads")).body.errors[0].code).toBe("MODULE_NOT_GRANTED");
    expect((await as("admin", "get", "/tasks")).status).toBe(200);
    expect(await seats("leads")).toBe(2); // the admin's seat came back
  });

  test("switching a module off keeps people's grants; switching it on restores them (lazy cascade)", async () => {
    await setOn("marketing", false);
    expect((await as("boss", "get", "/catalog")).body.errors[0].code).toBe("MODULE_DISABLED");
    const u1 = await tenant.runInOrg(org._id, () => User.findById(people.u1._id).lean());
    expect(u1.moduleAccess.keys).toEqual(expect.arrayContaining(["chat"])); // untouched
    await setOn("marketing", true);
    expect((await as("boss", "get", "/catalog")).status).toBe(200);
  });

  test("deactivating frees seats; reactivating when full is refused", async () => {
    const before = await seats("leads");
    expect((await as("boss", "patch", `/users/${people.u2._id}/status`).send({ status: "inactive" })).status).toBe(200);
    expect(await seats("leads")).toBe(before - 1);
    await setLimit("leads", before - 1);
    const back = await as("boss", "patch", `/users/${people.u2._id}/status`).send({ status: "active" });
    expect(back.status).toBe(409);
    await setLimit("leads", null);
    expect((await as("boss", "patch", `/users/${people.u2._id}/status`).send({ status: "active" })).status).toBe(200);
  });

  test("parallel deactivations release a seat only once", async () => {
    const before = await seats("chat");
    const [r1, r2] = await Promise.all([
      as("boss", "patch", `/users/${people.u1._id}/status`).send({ status: "inactive" }),
      as("boss", "patch", `/users/${people.u1._id}/status`).send({ status: "inactive" })
    ]);
    expect([r1.status, r2.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(await seats("chat")).toBe(before - 1);
    expect((await as("boss", "patch", `/users/${people.u1._id}/status`).send({ status: "active" })).status).toBe(200);
    expect(await seats("chat")).toBe(before);
    await login("u1"); // the status change signed u1 out
  });

  test("one module to many people at once, and taken away again", async () => {
    const add = await as("boss", "post", "/org/modules/tasks/members").send({ add: [people.u1._id, people.u2._id, people.mk._id].map(String) });
    expect(add.status).toBe(200);
    expect(add.body.data.changed).toBe(3);
    await login("u2"); // the status change above signed u2 out
    expect((await as("u2", "get", "/tasks")).status).toBe(200);
    const rem = await as("boss", "post", "/org/modules/tasks/members").send({ remove: [people.u2._id].map(String) });
    expect(rem.body.data.changed).toBe(1);
    expect((await as("u2", "get", "/tasks")).status).toBe(403);
  });

  test("the organisation's modules show seats in use", async () => {
    const res = await as("boss", "get", "/org/modules");
    expect(res.status).toBe(200);
    const tasks = res.body.data.find((m) => m.key === "tasks");
    expect(tasks).toMatchObject({ seatsUsed: await seats("tasks") });
    expect(res.body.data.find((m) => m.key === "payments")).toBeUndefined(); // not in this organisation
  });

  test("the counters match a full recount after everything above", async () => {
    const live = new Map((await tenant.runInOrg(org._id, () => SeatCounter.find().lean())).map((r) => [r.module, r.used]));
    const recounted = await tenant.runInOrg(org._id, () => access.recountSeats());
    for (const [key, n] of recounted) expect(live.get(key) || 0).toBe(n);
    // Every counter (including ones the recount inserted) belongs to the organisation
    expect(await SeatCounter.collection.countDocuments({ orgId: null })).toBe(0);
  });

  test("deleting a person gives their seats back", async () => {
    const before = await seats("chat");
    expect((await as("boss", "delete", `/users/${people.u1._id}`)).status).toBe(200);
    expect(await seats("chat")).toBe(before - 1);
  });
});
