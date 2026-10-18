/**
 * Organisation isolation (module-access-plan.md, Phase 1) against a real MongoDB
 * (in-memory). Proves that every way the app reaches the database is scoped to
 * one organisation, that a missing context fails closed, and that sign-in works
 * for people with accounts in several organisations without revealing them.
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";

const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const Task = require("../src/models/Task");
const Notification = require("../src/models/Notification");
const { nextSequence } = require("../src/models/Counter");
const { createOrgCache } = require("../src/utils/orgCache");
const { findSingleAccount, findAccounts } = require("../src/services/accountLookup.service");
const { newSalt, deriveAuthKey } = require("../src/utils/kdf");

jest.setTimeout(120000);

let mongod;
let orgA;
let orgB;
const PASSWORD = "Sample-Pass1";

const makeUser = async (org, fields) =>
  tenant.runInOrg(org._id, async () => {
    const salt = newSalt();
    const u = new User({ name: "Test", role: "user", ...fields });
    u.setDerivedCredential(deriveAuthKey(PASSWORD, salt), salt);
    return u.save();
  });

const makeTask = (org, by, title) =>
  tenant.runInOrg(org._id, () =>
    Task.create({ title, assignedBy: by._id, assignedTo: [by._id], dueDate: new Date(Date.now() + 3600e3) })
  );

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  [orgA, orgB] = await Organisation.create([
    { name: "Alpha Interiors", slug: "alpha" },
    { name: "Beta Homes", slug: "beta" }
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("tenant plugin: queries", () => {
  let a1;
  let b1;
  let taskA;
  let taskB;

  beforeAll(async () => {
    a1 = await makeUser(orgA, { email: "same@example.com", role: "superadmin" });
    b1 = await makeUser(orgB, { email: "same@example.com", role: "superadmin" }); // M5: allowed
    taskA = await makeTask(orgA, a1, "Alpha task");
    taskB = await makeTask(orgB, b1, "Beta task");
  });

  test("new documents get the current organisation", () => {
    expect(String(a1.orgId)).toBe(String(orgA._id));
    expect(String(taskB.orgId)).toBe(String(orgB._id));
  });

  test("find / findById / count / distinct only see their own organisation", async () => {
    await tenant.runInOrg(orgA._id, async () => {
      expect((await Task.find()).map((t) => t.title)).toEqual(["Alpha task"]);
      expect(await Task.findById(taskB._id)).toBeNull();
      expect(await Task.exists({ _id: taskB._id })).toBeNull();
      expect(await User.countDocuments({ email: "same@example.com" })).toBe(1);
      expect((await Task.distinct("title")).sort()).toEqual(["Alpha task"]);
    });
  });

  test("updates and deletes can't reach another organisation", async () => {
    await tenant.runInOrg(orgA._id, async () => {
      expect((await Task.updateOne({ _id: taskB._id }, { $set: { title: "hacked" } })).matchedCount).toBe(0);
      expect((await Task.updateMany({}, { $set: { priority: "high" } })).matchedCount).toBe(1);
      expect(await Task.findOneAndUpdate({ _id: taskB._id }, { $set: { title: "hacked" } })).toBeNull();
      expect((await Task.deleteOne({ _id: taskB._id })).deletedCount).toBe(0);
      expect((await Task.deleteMany({ title: "Beta task" })).deletedCount).toBe(0);
    });
    await tenant.runInOrg(orgB._id, async () => {
      const t = await Task.findById(taskB._id);
      expect(t.title).toBe("Beta task");
      expect(t.priority).not.toBe("high");
    });
  });

  test("orgId can't be changed by an update", async () => {
    await tenant.runInOrg(orgA._id, () => Task.updateOne({ _id: taskA._id }, { $set: { orgId: orgB._id } }));
    const raw = await Task.collection.findOne({ _id: taskA._id });
    expect(String(raw.orgId)).toBe(String(orgA._id));
  });

  test("aggregate gets an organisation $match first", async () => {
    const rows = await tenant.runInOrg(orgA._id, () => Task.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]));
    expect(rows[0].n).toBe(1);
  });

  test("populate can't pull in another organisation's document", async () => {
    // A task in A that (wrongly) points at B's user
    const t = await tenant.runInOrg(orgA._id, () =>
      Task.create({ title: "Cross ref", assignedBy: b1._id, assignedTo: [a1._id], dueDate: new Date(Date.now() + 3600e3) })
    );
    const loaded = await tenant.runInOrg(orgA._id, () => Task.findById(t._id).populate("assignedBy", "name"));
    expect(loaded.assignedBy).toBeNull();
  });

  test("upserts create the document in the current organisation", async () => {
    await tenant.runInOrg(orgB._id, () =>
      Notification.findOneAndUpdate(
        { recipient: b1._id, type: "system", title: "Hi" },
        { $setOnInsert: { message: "x" } },
        { upsert: true, new: true }
      )
    );
    const raw = await Notification.collection.findOne({ recipient: b1._id });
    expect(String(raw.orgId)).toBe(String(orgB._id));
  });

  test("insertMany fills orgId and refuses a different one", async () => {
    const [n] = await tenant.runInOrg(orgA._id, () =>
      Notification.insertMany([{ recipient: a1._id, type: "security_alert", title: "Bulk", message: "m" }])
    );
    expect(String(n.orgId)).toBe(String(orgA._id));
    await expect(
      tenant.runInOrg(orgA._id, () =>
        Notification.insertMany([{ recipient: a1._id, type: "security_alert", title: "Bad", message: "m", orgId: orgB._id }])
      )
    ).rejects.toThrow(/another organisation/);
  });

  test("bulkWrite upserts create the document in the current organisation", async () => {
    await tenant.runInOrg(orgB._id, () =>
      Notification.bulkWrite([
        { updateOne: { filter: { recipient: b1._id, title: "Bulk upsert" }, update: { $set: { message: "m", type: "security_alert" } }, upsert: true } }
      ])
    );
    const raw = await Notification.collection.findOne({ title: "Bulk upsert" });
    expect(String(raw.orgId)).toBe(String(orgB._id));
  });

  test("bulkWrite filters are scoped", async () => {
    const res = await tenant.runInOrg(orgA._id, () =>
      Task.bulkWrite([{ updateOne: { filter: { _id: taskB._id }, update: { $set: { title: "hacked" } } } }])
    );
    expect(res.matchedCount).toBe(0);
  });

  test("saving another organisation's document is refused", async () => {
    const foreign = await tenant.runAsSystem(() => Task.findById(taskB._id));
    foreign.title = "hacked";
    await expect(tenant.runInOrg(orgA._id, () => foreign.save())).rejects.toThrow(/another organisation/);
  });

  test("a document loaded without orgId (field selection) can still be saved in its own organisation", async () => {
    // Regression: publishing the first chat key loads the user with .select(...) and saves
    const partial = await tenant.runInOrg(orgB._id, () => Task.findById(taskB._id).select("title"));
    partial.title = "Renamed in B";
    await tenant.runInOrg(orgB._id, () => partial.save());
    const raw = await Task.collection.findOne({ _id: taskB._id });
    expect(raw.title).toBe("Renamed in B");
    expect(String(raw.orgId)).toBe(String(orgB._id));
  });

  test("…but saving such a document from another organisation still changes nothing", async () => {
    const partial = await tenant.runAsSystem(() => Task.findById(taskB._id).select("title"));
    partial.title = "hacked";
    await expect(tenant.runInOrg(orgA._id, () => partial.save())).rejects.toThrow(/No document found/);
    const raw = await Task.collection.findOne({ _id: taskB._id });
    expect(raw.title).not.toBe("hacked");
  });

  test("no context fails closed", async () => {
    await expect(Task.find()).rejects.toThrow(tenant.TenantContextError);
    await expect(Task.create({ title: "x", assignedBy: a1._id, dueDate: new Date() })).rejects.toThrow(tenant.TenantContextError);
    expect(() => Task.aggregate([])).not.toThrow(); // building is fine; running throws
    await expect(Task.aggregate([{ $match: {} }]).exec()).rejects.toThrow(tenant.TenantContextError);
  });

  test("estimatedDocumentCount is refused inside an organisation", async () => {
    await expect(tenant.runInOrg(orgA._id, () => Task.estimatedDocumentCount())).rejects.toThrow(/countDocuments/);
  });

  test("system writes must say which organisation", async () => {
    await expect(tenant.runAsSystem(() => Task.create({ title: "x", assignedBy: a1._id, dueDate: new Date() }))).rejects.toThrow(
      /orgId/
    );
  });

  test("email is unique within an organisation only", async () => {
    await expect(makeUser(orgA, { email: "same@example.com" })).rejects.toThrow(/duplicate key/);
  });
});

describe("tenant context", () => {
  test("setOrg only narrows a sign-in request, once", async () => {
    expect(() => tenant.runInOrg(orgA._id, () => tenant.setOrg(orgB._id))).toThrow();
    tenant.runResolvable(() => {
      expect(tenant.currentOrgId()).toBeNull();
      tenant.setOrg(orgA._id);
      expect(String(tenant.currentOrgId())).toBe(String(orgA._id));
      expect(() => tenant.setOrg(orgB._id)).toThrow();
    });
  });

  test("context survives awaits and timers", async () => {
    await tenant.runInOrg(orgB._id, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(String(tenant.currentOrgId())).toBe(String(orgB._id));
    });
  });

  test("sequences count per organisation", async () => {
    const a = await tenant.runInOrg(orgA._id, () => nextSequence("t", 0));
    const a2 = await tenant.runInOrg(orgA._id, () => nextSequence("t", 0));
    const b = await tenant.runInOrg(orgB._id, () => nextSequence("t", 0));
    expect([a, a2, b]).toEqual([1, 2, 1]);
  });
});

describe("per-organisation cache", () => {
  test("values are kept apart, loads are shared, and the oldest is evicted", async () => {
    const cache = createOrgCache({ ttlMs: 60000, max: 2 });
    let loads = 0;
    const loader = async (orgId) => {
      loads += 1;
      return `v-${orgId}`;
    };
    const [x, y] = await Promise.all([cache.get(loader, "o1"), cache.get(loader, "o1")]);
    expect([x, y, loads]).toEqual(["v-o1", "v-o1", 1]); // single flight
    expect(await cache.get(loader, "o2")).toBe("v-o2");
    await cache.get(loader, "o1"); // o1 becomes newest
    await cache.get(loader, "o3"); // evicts o2
    expect(cache.size()).toBe(2);
    loads = 0;
    await cache.get(loader, "o1");
    expect(loads).toBe(0);
    await cache.get(loader, "o2");
    expect(loads).toBe(1);
  });

  test("without an organisation the cache refuses to guess", async () => {
    const cache = createOrgCache();
    await expect(cache.get(async () => 1)).rejects.toThrow(tenant.TenantContextError);
  });
});

describe("account lookup across organisations (M5)", () => {
  test("an email in two organisations is ambiguous without a code", async () => {
    expect(await findAccounts({ email: "same@example.com" })).toHaveLength(2);
    expect(await findSingleAccount({ email: "same@example.com" })).toBeNull();
    const b = await findSingleAccount({ email: "same@example.com" }, { organisation: "beta" });
    expect(String(b.orgId)).toBe(String(orgB._id));
    expect(await findSingleAccount({ email: "same@example.com" }, { organisation: "nope" })).toBeNull();
  });
});

describe("HTTP: sign-in and isolation", () => {
  const app = require("../src/app");
  const prelogin = (body) => request(app).post("/api/v1/auth/prelogin").send(body);
  const login = async (identifier, organisation) => {
    const pre = await prelogin({ identifier, ...(organisation && { organisation }) });
    const authKey = deriveAuthKey(PASSWORD, pre.body.data.kdf.salt);
    return request(app)
      .post("/api/v1/auth/login")
      .send({ identifier, authKey, ...(organisation && { organisation }) });
  };
  const cookiesOf = (res) => res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");

  let solo;
  beforeAll(async () => {
    solo = await makeUser(orgA, { email: "solo@example.com", role: "superadmin" });
  });

  test("sign-in always needs the organisation code (D-R1)", async () => {
    expect((await prelogin({ identifier: "solo@example.com" })).status).toBe(400);
    const res = await login("solo@example.com", "alpha");
    expect(res.status).toBe(200);
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookiesOf(res));
    expect(me.body.data.organisation).toMatchObject({ slug: "alpha", name: "Alpha Interiors" });
  });

  // Every Set-Cookie that clears a cookie (empty value or a past expiry)
  const cleared = (res) =>
    (res.headers["set-cookie"] || [])
      .filter((c) => /^[^=]+=;/.test(c) || /Expires=Thu, 01 Jan 1970/i.test(c))
      .map((c) => c.split("=")[0])
      .sort();

  test("sign-out clears the cookies and ends this device's session", async () => {
    const res = await login("solo@example.com", "alpha");
    const cookie = cookiesOf(res);
    const out = await request(app).post("/api/v1/auth/logout").set("Cookie", cookie);
    expect(out.status).toBe(200);
    expect(cleared(out)).toEqual(["accessToken", "refreshToken", "role"]);
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookie); // the old cookies no longer work
    expect(me.status).toBe(401);
  });

  test("sign-out still works (and clears the cookies) when the account was deleted", async () => {
    const gone = await makeUser(orgA, { email: "gone@example.com", role: "user" });
    const cookie = cookiesOf(await login("gone@example.com", "alpha"));
    await User.collection.deleteOne({ _id: gone._id });
    const out = await request(app).post("/api/v1/auth/logout").set("Cookie", cookie);
    expect(out.status).toBe(200); // used to be 401 with the cookies left in place
    expect(cleared(out)).toEqual(["accessToken", "refreshToken", "role"]);
  });

  test("a refused refresh clears the cookies (no bouncing between login and dashboard)", async () => {
    const gone = await makeUser(orgA, { email: "gone2@example.com", role: "user" });
    const cookie = cookiesOf(await login("gone2@example.com", "alpha"));
    await User.collection.deleteOne({ _id: gone._id });
    const r = await request(app).post("/api/v1/auth/refresh").set("Cookie", cookie);
    expect(r.status).toBe(401);
    expect(cleared(r)).toEqual(["accessToken", "refreshToken", "role"]);
  });

  test("sign-out with no or forged cookies just clears them", async () => {
    const none = await request(app).post("/api/v1/auth/logout");
    expect(none.status).toBe(200);
    const forged = await request(app).post("/api/v1/auth/logout").set("Cookie", "accessToken=not.a.jwt; refreshToken=forged");
    expect(forged.status).toBe(200);
    expect(cleared(forged)).toEqual(["accessToken", "refreshToken", "role"]);
  });

  test("known and unknown accounts answer alike in every organisation, and no answer repeats across codes", async () => {
    const salts = new Set();
    for (const identifier of ["solo@example.com", "nobody@example.com", "same@example.com"]) {
      for (const organisation of ["alpha", "beta", "no-such-org"]) {
        const res = await prelogin({ identifier, organisation });
        expect(Object.keys(res.body.data).sort()).toEqual(["kdf", "legacy"]);
        salts.add(res.body.data.kdf.salt);
      }
    }
    // 9 lookups, 9 different salts: nothing to compare between codes
    expect(salts.size).toBe(9);
  });

  test("a step token can be used only once", async () => {
    const authService = require("../src/services/auth.service");
    const decoded = { jti: "test-jti-1", exp: Math.floor(Date.now() / 1000) + 60 };
    await tenant.runAsSystem(() => authService.consumeStepToken(decoded));
    await expect(tenant.runAsSystem(() => authService.consumeStepToken(decoded))).rejects.toMatchObject({ statusCode: 401 });
  });

  test("the platform level never sees records that are missing an organisation id", async () => {
    await Task.collection.insertOne({ title: "Unmigrated", assignedBy: new mongoose.Types.ObjectId(), dueDate: new Date() });
    expect(await tenant.runAsPlatform(() => Task.find({ title: "Unmigrated" }))).toEqual([]);
    await Task.collection.deleteOne({ title: "Unmigrated" });
  });

  test("a wrong organisation code fails like a wrong password", async () => {
    const res = await login("solo@example.com", "beta");
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/organisation code/);
  });

  test("with a code, the right organisation's account signs in", async () => {
    const res = await login("same@example.com", "beta");
    expect(res.status).toBe(200);
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookiesOf(res));
    expect(me.body.data.organisation.slug).toBe("beta");
  });

  test("an admin can't read another organisation's user (404, not 403)", async () => {
    const res = await login("solo@example.com", "alpha");
    const cookie = cookiesOf(res);
    const other = await tenant.runInOrg(orgB._id, () => User.findOne({ email: "same@example.com" }));
    const mine = await request(app).get(`/api/v1/users/${solo._id}`).set("Cookie", cookie);
    expect(mine.status).toBe(200);
    const theirs = await request(app).get(`/api/v1/users/${other._id}`).set("Cookie", cookie);
    expect(theirs.status).toBe(404);
    const list = await request(app).get("/api/v1/users").set("Cookie", cookie);
    const emails = JSON.stringify(list.body);
    expect(emails).not.toContain(String(other._id));
  });

  test("a suspended organisation locks its people out at once", async () => {
    const res = await login("solo@example.com", "alpha");
    const cookie = cookiesOf(res);
    await Organisation.updateOne({ _id: orgA._id }, { $set: { status: "suspended" } });
    require("../src/services/organisation.service").invalidate(orgA._id);
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(403);
    expect(me.body.errors?.[0]?.code || me.body.code).toBe("ORG_SUSPENDED");
    await Organisation.updateOne({ _id: orgA._id }, { $set: { status: "active" } });
    require("../src/services/organisation.service").invalidate(orgA._id);
  });

  test("public customer sign-up is gone (customers are added by their organisation)", async () => {
    const before = await tenant.runAsSystem(() => User.countDocuments());
    const res = await request(app).post("/api/v1/customer/auth/register").send({ name: "X", email: "x@example.com" });
    expect([401, 404]).toContain(res.status); // no such public route (falls through to signed-in routes)
    expect(await tenant.runAsSystem(() => User.countDocuments())).toBe(before);
  });
});
