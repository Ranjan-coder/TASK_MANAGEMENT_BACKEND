/**
 * Staff directory: people pickers show only active staff of the person's own
 * organisation (never customers, never another organisation), page with a
 * keyset cursor, and the server refuses non-staff as task assignees or chat members.
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
const MODULES = ["tasks", "projects", "chat"].map((key) => ({ key, enabled: true }));

let mongod;
let app;
let alpha;
let beta;
const ids = {};

const makeUser = (orgId, fields) =>
  tenant.runInOrg(orgId, async () => {
    const salt = newSalt();
    const u = new User({ name: "Person", status: "active", ...fields });
    u.setDerivedCredential(deriveAuthKey(PASSWORD, salt), salt);
    await u.save();
    ids[fields.email] = String(u._id);
    return u;
  });

const login = async (email) => {
  const organisation = email.split("@")[1].split(".")[0];
  const pre = await request(app).post("/api/v1/auth/prelogin").send({ identifier: email, organisation });
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ identifier: email, organisation, authKey: deriveAuthKey(PASSWORD, pre.body.data.kdf.salt) });
  expect(res.status).toBe(200);
  return res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
};

let bossCookie;
let staffCookie;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  app = require("../src/app");

  alpha = await Organisation.create({ name: "Alpha", slug: "alpha", modules: MODULES });
  beta = await Organisation.create({ name: "Beta", slug: "beta", modules: MODULES });

  await makeUser(alpha._id, { email: "boss@alpha.test", name: "Boss Alpha", role: "superadmin" });
  await makeUser(alpha._id, { email: "ravi@alpha.test", name: "Ravi Kumar", role: "user", designation: "Designer", moduleAccess: { keys: ["chat", "projects"] } });
  await makeUser(alpha._id, { email: "anil@alpha.test", name: "Anil Rao", role: "user", moduleAccess: { keys: ["chat", "projects"] } });
  await makeUser(alpha._id, { email: "nochat@alpha.test", name: "No Chat", role: "user", moduleAccess: { keys: ["tasks"] } });
  await makeUser(alpha._id, { email: "gone@alpha.test", name: "Gone Person", role: "user", status: "inactive", moduleAccess: { keys: ["chat", "projects"] } });
  await makeUser(alpha._id, { email: "cust@alpha.test", name: "Customer Alpha", role: "customer" });
  // Enough colleagues for more than one page
  for (let i = 0; i < 25; i++) {
    await makeUser(alpha._id, { email: `p${i}@alpha.test`, name: `Person ${String(i).padStart(2, "0")}`, role: "user", moduleAccess: { keys: ["chat", "projects"] } });
  }
  await makeUser(beta._id, { email: "ravi@beta.test", name: "Ravi Beta", role: "user", moduleAccess: { keys: ["chat", "projects"] } });

  bossCookie = await login("boss@alpha.test");
  staffCookie = await login("ravi@alpha.test");
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const people = (cookie, query = "") => request(app).get(`/api/v1/chat/people${query}`).set("Cookie", cookie);

describe("chat people (staff directory)", () => {
  test("only active staff of my organisation who have chat; never customers, others' staff or me", async () => {
    const all = [];
    let cursor;
    do {
      const res = await people(staffCookie, cursor ? `?cursor=${cursor}` : "");
      expect(res.status).toBe(200);
      all.push(...res.body.data.people);
      cursor = res.body.data.next;
    } while (cursor);
    const names = all.map((p) => p.name);
    expect(names).toContain("Anil Rao");
    expect(names).toContain("Boss Alpha"); // superadmins hold every module
    for (const hidden of ["Ravi Kumar", "Customer Alpha", "Ravi Beta", "No Chat", "Gone Person"]) expect(names).not.toContain(hidden);
    // 25 colleagues + Anil + Boss, each exactly once, in name order
    expect(all).toHaveLength(27);
    expect(new Set(all.map((p) => p._id)).size).toBe(27);
    expect([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(names);
  });

  test("pages are full and the cursor continues where the last page ended", async () => {
    const first = await people(staffCookie);
    expect(first.body.data.people).toHaveLength(20);
    expect(first.body.data.next).toEqual(expect.any(String));
    const second = await people(staffCookie, `?cursor=${first.body.data.next}`);
    expect(second.body.data.people).toHaveLength(7);
    expect(second.body.data.next).toBeNull();
  });

  test("search matches the start of any word, and no personal details are returned", async () => {
    const res = await people(bossCookie, "?search=ra");
    const names = res.body.data.people.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Ravi Kumar", "Anil Rao"]));
    expect(names).not.toContain("Ravi Beta");
    for (const p of res.body.data.people) {
      expect(Object.keys(p).sort()).toEqual(["_id", "avatarUrl", "designation", "keyVersion", "name", "publicKey", "role"]);
    }
    // Regex characters are matched literally
    expect((await people(bossCookie, "?search=.*")).body.data.people).toEqual([]);
  });

  test("a bad cursor is ignored, not an error", async () => {
    expect((await people(staffCookie, "?cursor=not-a-cursor")).status).toBe(200);
  });
});

describe("the Users list", () => {
  test("role=staff leaves customers out; the customer filter still works", async () => {
    const staff = await request(app).get("/api/v1/users?role=staff&limit=100").set("Cookie", bossCookie);
    expect(staff.status).toBe(200);
    expect(staff.body.data.every((u) => u.role !== "customer")).toBe(true);
    expect(staff.body.data.map((u) => u.name)).not.toContain("Ravi Beta");
    const customers = await request(app).get("/api/v1/users?role=customer").set("Cookie", bossCookie);
    expect(customers.body.data.map((u) => u.name)).toEqual(["Customer Alpha"]);
  });
});

describe("the server refuses non-staff", () => {
  const task = (assignedTo) => ({ title: "Check the drawings", assignedTo, dueDate: new Date(Date.now() + 86400e3).toISOString() });

  test("tasks can be assigned to staff only, and only in my organisation", async () => {
    const ok = await request(app).post("/api/v1/tasks").set("Cookie", bossCookie).send(task([ids["anil@alpha.test"]]));
    expect(ok.status).toBe(201);
    for (const who of ["cust@alpha.test", "ravi@beta.test", "gone@alpha.test"]) {
      const res = await request(app).post("/api/v1/tasks").set("Cookie", bossCookie).send(task([ids[who]]));
      expect(res.status).toBe(400);
    }
    // Reassigning and editing follow the same rule
    const id = ok.body.data._id;
    expect((await request(app).patch(`/api/v1/tasks/${id}`).set("Cookie", bossCookie).send({ assignedTo: [ids["ravi@beta.test"]] })).status).toBe(400);
    expect((await request(app).patch(`/api/v1/tasks/${id}`).set("Cookie", bossCookie).send({ watchers: [ids["cust@alpha.test"]] })).status).toBe(400);
  });

  test("a chat can't be started with someone from another organisation", async () => {
    const res = await request(app).post("/api/v1/chat/conversations").set("Cookie", staffCookie).send({ type: "dm", memberIds: [ids["ravi@beta.test"]] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe("MEMBER_NOT_FOUND");
    const ok = await request(app).post("/api/v1/chat/conversations").set("Cookie", staffCookie).send({ type: "dm", memberIds: [ids["anil@alpha.test"]] });
    expect([200, 201]).toContain(ok.status);
  });
});
