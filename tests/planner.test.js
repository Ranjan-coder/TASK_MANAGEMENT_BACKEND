/**
 * Planner module (planner-module-plan.md) against a real (in-memory) MongoDB:
 * on by default, customer opt-in, switching off, and the encrypted, owner-only API.
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";
process.env.API_RATE_LIMIT_PER_MIN = "100000"; // many quick requests from one test "network"

const mongoose = require("mongoose");
const request = require("supertest");
const crypto = require("crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const access = require("../src/services/moduleAccess.service");
const { invalidate } = require("../src/services/organisation.service");
const { newSalt, deriveAuthKey } = require("../src/utils/kdf");

jest.setTimeout(120000);

const PASSWORD = "Sample-Pass1";
// What a browser would send: AES-GCM ciphertext + 12-byte IV (content is opaque to the server)
const enc = (bytes = 40) => ({ ciphertext: crypto.randomBytes(bytes).toString("base64"), iv: crypto.randomBytes(12).toString("base64") });
const wrapped = () => `${crypto.randomBytes(12).toString("base64")}:${crypto.randomBytes(48).toString("base64")}`;

let mongod;
let app;
let org;
const people = {};
const cookies = {};

const makeUser = (key, fields) =>
  tenant.runInOrg(org._id, async () => {
    const salt = newSalt();
    const u = new User({ name: key, email: `${key}@acme.test`, ...fields });
    u.setDerivedCredential(deriveAuthKey(PASSWORD, salt), salt);
    await access.transition(null, u, () => u.save());
    people[key] = u;
  });
const login = async (key) => {
  const identifier = `${key}@acme.test`;
  const pre = await request(app).post("/api/v1/auth/prelogin").send({ identifier, organisation: "acme" });
  const res = await request(app).post("/api/v1/auth/login").send({ identifier, organisation: "acme", authKey: deriveAuthKey(PASSWORD, pre.body.data.kdf.salt) });
  expect(res.status).toBe(200);
  cookies[key] = res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
};
const as = (key, method, url) => request(app)[method](`/api/v1${url}`).set("Cookie", cookies[key]);
const setPlanner = async (enabled) => {
  await Organisation.updateOne({ _id: org._id }, { $pull: { modules: { key: "planner" } } });
  if (enabled === false) await Organisation.updateOne({ _id: org._id }, { $push: { modules: { key: "planner", enabled: false } } });
  invalidate(org._id);
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  app = require("../src/app");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  // Planner is NOT in this list: it is on by default
  org = await Organisation.create({ name: "Acme", slug: "acme", modules: ["projects", "customer_portal", "tasks"].map((key) => ({ key, enabled: true })) });
  await makeUser("boss", { role: "superadmin" });
  await makeUser("admin", { role: "admin" });
  await makeUser("staff", { role: "user" });
  await makeUser("other", { role: "user" });
  await makeUser("cust", { role: "customer", phone: "+919876543210", phoneVerified: true });
  for (const k of Object.keys(people)) await login(k);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("on by default, staff only, customer opt-in", () => {
  test("every staff member has it without being given it, and it takes no seats", async () => {
    expect((await as("staff", "get", "/planner/notes")).status).toBe(200);
    const mods = await as("boss", "get", "/org/modules");
    expect(mods.body.data.find((m) => m.key === "planner")).toMatchObject({ defaultOn: true, seatLimit: null, seatsUsed: null, customersEnabled: false });
    expect((await as("boss", "post", "/org/modules/planner/members").send({ add: [String(people.staff._id)] })).body.errors[0].code).toBe("MODULE_DEFAULT_ON");
  });

  test("customers can't use it until the superadmin opens it to them", async () => {
    expect((await as("cust", "get", "/planner/notes")).body.errors[0].code).toBe("MODULE_NOT_GRANTED");
    expect((await as("admin", "patch", "/org/modules/planner/customers").send({ enabled: true })).status).toBe(403);
    expect((await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: true })).status).toBe(200);
    expect((await as("cust", "get", "/planner/notes")).status).toBe(200);
    expect((await as("cust", "get", "/auth/me")).body.data.modules).toContain("planner");
  });

  test("only modules marked for it can be opened to customers", async () => {
    expect((await as("boss", "patch", "/org/modules/tasks/customers").send({ enabled: true })).status).toBe(400);
  });

  test("the product owner switching it off closes it for everyone, customers included; data is kept", async () => {
    const created = await as("staff", "post", "/planner/notes").send({ enc: enc() });
    await setPlanner(false);
    expect((await as("staff", "get", "/planner/notes")).body.errors[0].code).toBe("MODULE_DISABLED");
    expect((await as("cust", "get", "/planner/notes")).status).toBe(403);
    await setPlanner(true);
    const list = await as("staff", "get", "/planner/notes");
    expect(list.body.data.items.map((n) => n._id)).toContain(created.body.data._id);
  });

  test("closing it to customers takes it away from them again", async () => {
    expect((await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: false })).status).toBe(200);
    expect((await as("cust", "get", "/planner/notes")).status).toBe(403);
  });
});

describe("vault (the person's wrapped planner key)", () => {
  test("is added once per key version and never replaced", async () => {
    expect((await as("staff", "get", "/planner/vault")).body.data.wraps).toBeNull();
    const first = await as("staff", "put", "/planner/vault").send({ keyVersion: 1, wrapped: wrapped() });
    expect(first.status).toBe(200);
    expect((await as("staff", "put", "/planner/vault").send({ keyVersion: 1, wrapped: wrapped() })).status).toBe(409);
    const second = await as("staff", "put", "/planner/vault").send({ keyVersion: 2, wrapped: wrapped() });
    expect(second.body.data.wraps.map((w) => w.keyVersion)).toEqual([1, 2]);
    expect((await as("other", "get", "/planner/vault")).body.data.wraps).toBeNull(); // per person
  });

  test("refuses anything that isn't a wrapped key", async () => {
    expect((await as("other", "put", "/planner/vault").send({ keyVersion: 1, wrapped: "plain text" })).status).toBe(400);
  });
});

describe("notes", () => {
  let note;

  test("are stored only as ciphertext; plain text is refused", async () => {
    expect((await as("staff", "post", "/planner/notes").send({ title: "Secret" })).status).toBe(400);
    expect((await as("staff", "post", "/planner/notes").send({ enc: { ciphertext: "not base64 !!", iv: "x" } })).status).toBe(400);
    const res = await as("staff", "post", "/planner/notes").send({ enc: enc(), color: "yellow", pinned: true });
    expect(res.status).toBe(201);
    note = res.body.data;
    expect(note).toMatchObject({ pinned: true, color: "yellow", version: 1 });
    const raw = await mongoose.connection.db.collection("notes").findOne({ _id: new mongoose.Types.ObjectId(note._id) });
    expect(Object.keys(raw).sort()).toEqual(["__v", "_id", "archived", "color", "createdAt", "enc", "orgId", "owner", "pinned", "updatedAt", "version"].sort());
  });

  test("belong to their owner only (another person gets 404)", async () => {
    expect((await as("other", "patch", `/planner/notes/${note._id}`).send({ version: 1, pinned: false })).status).toBe(404);
    expect((await as("other", "delete", `/planner/notes/${note._id}`)).status).toBe(404);
    expect((await as("other", "get", "/planner/notes")).body.data.items).toEqual([]);
    expect((await as("boss", "get", "/planner/notes")).body.data.items).toEqual([]); // not even a superadmin
  });

  test("a stale version is refused and the current copy comes back", async () => {
    const ok = await as("staff", "patch", `/planner/notes/${note._id}`).send({ version: 1, enc: enc() });
    expect(ok.body.data.version).toBe(2);
    const stale = await as("staff", "patch", `/planner/notes/${note._id}`).send({ version: 1, pinned: false });
    expect(stale.status).toBe(409);
    expect(stale.body.errors[0]).toMatchObject({ code: "STALE_VERSION", current: { version: 2 } });
  });

  test("lists page with a cursor, newest first, archived kept apart", async () => {
    for (let i = 0; i < 5; i++) await as("other", "post", "/planner/notes").send({ enc: enc() });
    const page1 = await as("other", "get", "/planner/notes?limit=2");
    expect(page1.body.data.items).toHaveLength(2);
    const page2 = await as("other", "get", `/planner/notes?limit=2&cursor=${page1.body.data.nextCursor}`);
    expect(page2.body.data.items).toHaveLength(2);
    const ids = new Set([...page1.body.data.items, ...page2.body.data.items].map((n) => n._id));
    expect(ids.size).toBe(4); // no repeats across pages
    const first = page1.body.data.items[0];
    await as("other", "patch", `/planner/notes/${first._id}`).send({ version: first.version, archived: true });
    expect((await as("other", "get", "/planner/notes?archived=true")).body.data.items.map((n) => n._id)).toEqual([first._id]);
  });

  test("deleting works once", async () => {
    expect((await as("staff", "delete", `/planner/notes/${note._id}`)).status).toBe(200);
    expect((await as("staff", "delete", `/planner/notes/${note._id}`)).status).toBe(404);
  });
});

describe("fractional ranks (pure)", () => {
  const { between, spread } = require("../src/modules/planner/rank");
  test("random inserts stay ordered and unique; keys stay short", () => {
    const keys = [between()];
    for (let i = 0; i < 2000; i++) {
      const j = Math.floor(Math.random() * (keys.length + 1));
      keys.splice(j, 0, between(keys[j - 1] || "", keys[j] === undefined ? null : keys[j]));
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(10);
    expect([...spread(500)].sort()).toEqual(spread(500));
  });
});

describe("todos", () => {
  let list;
  let other;
  const items = [];
  const order = async (listId) => (await as("staff", "get", `/planner/lists/${listId}/items`)).body.data.map((i) => i._id);

  test("lists and items are created at the end, in order", async () => {
    list = (await as("staff", "post", "/planner/lists").send({ enc: enc() })).body.data;
    other = (await as("staff", "post", "/planner/lists").send({ enc: enc() })).body.data;
    expect(list.rank < other.rank).toBe(true);
    for (let i = 0; i < 4; i++) items.push((await as("staff", "post", `/planner/lists/${list._id}/items`).send({ enc: enc() })).body.data);
    expect(await order(list._id)).toEqual(items.map((i) => i._id));
  });

  test("moving an item writes only that item", async () => {
    // Move the last item between the first and second
    const res = await as("staff", "post", `/planner/items/${items[3]._id}/move`).send({ before: items[0]._id, after: items[1]._id });
    expect(res.status).toBe(200);
    expect(await order(list._id)).toEqual([items[0], items[3], items[1], items[2]].map((i) => i._id));
    // The others kept their versions (nothing renumbered)
    const all = (await as("staff", "get", `/planner/lists/${list._id}/items`)).body.data;
    expect(all.filter((i) => i._id !== items[3]._id).every((i) => i.version === 1)).toBe(true);
  });

  test("neighbours given in the wrong order are refused (someone reordered meanwhile)", async () => {
    const res = await as("staff", "post", `/planner/items/${items[2]._id}/move`).send({ before: items[1]._id, after: items[0]._id });
    expect(res.status).toBe(409);
    expect(res.body.errors[0].code).toBe("STALE_ORDER");
  });

  test("an item can move to another of the person's lists", async () => {
    const res = await as("staff", "post", `/planner/items/${items[2]._id}/move`).send({ list: other._id });
    expect(res.body.data.list).toBe(other._id);
    expect(await order(other._id)).toEqual([items[2]._id]);
    // ...but never into someone else's list
    const theirs = (await as("other", "post", "/planner/lists").send({ enc: enc() })).body.data;
    expect((await as("staff", "post", `/planner/items/${items[1]._id}/move`).send({ list: theirs._id })).status).toBe(404);
  });

  test("done and due dates; due items across lists", async () => {
    const soon = new Date(Date.now() + 3600e3).toISOString();
    const upd = await as("staff", "patch", `/planner/items/${items[0]._id}`).send({ version: 1, dueAt: soon });
    expect(upd.body.data.dueAt).toBe(soon);
    const done = await as("staff", "patch", `/planner/items/${items[1]._id}`).send({ version: 1, done: true });
    expect(done.body.data.done).toBe(true);
    expect(done.body.data.doneAt).toBeTruthy();
    const from = new Date(Date.now() - 3600e3).toISOString();
    const to = new Date(Date.now() + 86400e3).toISOString();
    const due = await as("staff", "get", `/planner/todos/due?from=${from}&to=${to}`);
    expect(due.body.data.map((i) => i._id)).toEqual([items[0]._id]);
  });

  test("lists and items belong to their owner only", async () => {
    expect((await as("other", "get", `/planner/lists/${list._id}/items`)).status).toBe(404);
    expect((await as("other", "patch", `/planner/items/${items[0]._id}`).send({ version: 2, done: true })).status).toBe(404);
    expect((await as("other", "get", "/planner/lists")).body.data.map((l) => l._id)).not.toContain(list._id);
  });

  test("deleting a list deletes its items", async () => {
    expect((await as("staff", "delete", `/planner/lists/${list._id}`)).status).toBe(200);
    const left = await tenant.runInOrg(org._id, () => require("../src/modules/planner/models/TodoItem").countDocuments({ list: list._id }));
    expect(left).toBe(0);
  });
});

describe("reminders", () => {
  const reminders = require("../src/modules/planner/reminders.service");
  const Reminder = require("../src/modules/planner/models/Reminder");
  const Notification = require("../src/models/Notification");
  const runDue = (at) => tenant.runInOrg(org._id, () => reminders.processDue(at));
  const soon = () => new Date(Date.now() + 2000).toISOString();

  test("plain text and unknown time zones are refused", async () => {
    expect((await as("staff", "post", "/planner/reminders").send({ text: "x", at: soon() })).status).toBe(400);
    expect((await as("staff", "post", "/planner/reminders").send({ enc: enc(), at: soon(), timeZone: "Mars/Olympus" })).status).toBe(400);
    expect((await as("staff", "post", "/planner/reminders").send({ enc: enc(), at: "2001-01-01T00:00:00Z" })).status).toBe(400);
  });

  test("a due reminder is sent exactly once, even with two schedulers at the same moment", async () => {
    const r = (await as("staff", "post", "/planner/reminders").send({ enc: enc(), at: soon() })).body.data;
    const at = new Date(Date.now() + 10_000);
    const [a, b] = await Promise.all([runDue(at), runDue(at)]);
    expect(a + b).toBe(1);
    const notes = await tenant.runInOrg(org._id, () => Notification.find({ recipient: people.staff._id, type: "planner_reminder" }).lean());
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/^Your reminder for /); // generic: the text is encrypted
    const after = await tenant.runInOrg(org._id, () => Reminder.findById(r._id).lean());
    expect(after.status).toBe("done");
    expect(await runDue(new Date(Date.now() + 20_000))).toBe(0);
  });

  test("a daily reminder moves to the same local time tomorrow", async () => {
    const r = (await as("staff", "post", "/planner/reminders").send({ enc: enc(), at: soon(), timeZone: "Asia/Kolkata", recurrence: { freq: "daily" } })).body.data;
    await runDue(new Date(Date.now() + 10_000));
    const after = await tenant.runInOrg(org._id, () => Reminder.findById(r._id).lean());
    expect(after.status).toBe("active");
    expect(new Date(after.anchorAt) - new Date(r.anchorAt)).toBe(24 * 3600 * 1000);
    expect(+after.nextAt).toBe(+after.anchorAt);
  });

  test("snooze moves only this occurrence; done on a repeating reminder skips to the next one", async () => {
    const at = new Date(Date.now() + 3600e3).toISOString();
    const r = (await as("staff", "post", "/planner/reminders").send({ enc: enc(), at, recurrence: { freq: "weekly" } })).body.data;
    const snoozed = (await as("staff", "post", `/planner/reminders/${r._id}/snooze`).send({ minutes: 10 })).body.data;
    expect(snoozed.anchorAt).toBe(r.anchorAt);
    expect(new Date(snoozed.nextAt) < new Date(r.anchorAt)).toBe(true);
    const done = (await as("staff", "post", `/planner/reminders/${r._id}/done`)).body.data;
    expect(new Date(done.anchorAt) - new Date(r.anchorAt)).toBe(7 * 24 * 3600 * 1000);
    expect(done.status).toBe("active");
  });

  test("reminders belong to their owner only", async () => {
    const r = (await as("staff", "post", "/planner/reminders").send({ enc: enc(), at: new Date(Date.now() + 3600e3).toISOString() })).body.data;
    expect((await as("other", "post", `/planner/reminders/${r._id}/snooze`).send({ minutes: 5 })).status).toBe(404);
    expect((await as("other", "delete", `/planner/reminders/${r._id}`)).status).toBe(404);
    expect((await as("other", "get", "/planner/reminders")).body.data.map((x) => x._id)).not.toContain(r._id);
  });
});

describe("meetings", () => {
  const meetings = require("../src/modules/planner/meetings.service");
  const Notification = require("../src/models/Notification");
  const key = (user) => ({ user: String(user), wrapped: wrapped(), recipientKeyVersion: 1, senderKeyVersion: 1 });
  const at = (minutes) => new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const range = () => `from=${at(-60)}&to=${at(60 * 24 * 7)}`;
  let m;

  test("merging busy intervals (pure)", () => {
    expect(meetings.mergeIntervals([[5, 7], [1, 3], [2, 4], [7, 8], [10, 11]])).toEqual([[1, 4], [5, 8], [10, 11]]);
  });

  test("everyone invited needs their own copy of the key", async () => {
    const bad = await as("staff", "post", "/planner/meetings").send({ startAt: at(120), endAt: at(150), enc: enc(), attendees: [key(people.staff._id)], reminderMinutes: 10 });
    expect(bad.status).toBe(201); // alone is fine
    const missing = await as("staff", "post", "/planner/meetings").send({
      startAt: at(120),
      endAt: at(150),
      enc: enc(),
      attendees: [key(people.staff._id), { ...key(people.other._id), user: "64b7f0c2a1b2c3d4e5f60799" }]
    });
    expect(missing.status).toBe(400);
  });

  test("a colleague is invited; each person gets only their own wrapped key", async () => {
    const res = await as("staff", "post", "/planner/meetings").send({
      startAt: at(120),
      endAt: at(150),
      enc: enc(),
      attendees: [key(people.staff._id), key(people.other._id)],
      reminderMinutes: 10
    });
    expect(res.status).toBe(201);
    m = res.body.data;
    expect(m.isOrganiser).toBe(true);
    const theirs = await as("other", "get", `/planner/meetings?${range()}`);
    const seen = theirs.body.data.find((x) => x._id === m._id);
    expect(seen.myResponse).toBe("pending");
    expect(seen.myKey.wrapped).not.toBe(m.myKey.wrapped);
    expect(JSON.stringify(seen)).not.toContain(m.myKey.wrapped); // never someone else's key
    expect((await as("boss", "get", `/planner/meetings/${m._id}`)).status).toBe(404); // not invited
    const invite = await tenant.runInOrg(org._id, () => Notification.findOne({ recipient: people.other._id, type: "meeting_invite" }).lean());
    expect(invite.message).toMatch(/^staff invited you to a meeting on /);
  });

  test("attendees answer; a new time asks everyone again", async () => {
    const ans = await as("other", "post", `/planner/meetings/${m._id}/respond`).send({ response: "accepted" });
    expect(ans.body.data.myResponse).toBe("accepted");
    const moved = await as("staff", "patch", `/planner/meetings/${m._id}`).send({ version: ans.body.data.version, startAt: at(180), endAt: at(210) });
    expect(moved.status).toBe(200);
    expect(moved.body.data.attendees.find((a) => a.user === String(people.other._id)).response).toBe("pending");
    m = moved.body.data;
  });

  test("busy times show only start and end, merged", async () => {
    await as("other", "post", "/planner/meetings").send({ startAt: at(200), endAt: at(240), enc: enc(), attendees: [key(people.other._id)] });
    const res = await as("staff", "get", `/planner/availability?users=${people.other._id}&${range()}`);
    expect(res.status).toBe(200);
    const busy = res.body.data[0].busy;
    expect(busy).toHaveLength(1); // 180–210 and 200–240 merged
    expect(Object.keys(busy[0]).sort()).toEqual(["end", "start"]);
    expect((await as("cust", "get", `/planner/availability?users=${people.other._id}&${range()}`)).status).toBe(403);
  });

  test("removing someone needs a new key; they lose access", async () => {
    const noRekey = await as("staff", "patch", `/planner/meetings/${m._id}`).send({ version: m.version, attendees: [key(people.staff._id)] });
    expect(noRekey.body.errors[0].code).toBe("REKEY_REQUIRED");
    const rekeyed = await as("staff", "patch", `/planner/meetings/${m._id}`).send({ version: m.version, attendees: [key(people.staff._id)], enc: enc(), rekey: true });
    expect(rekeyed.body.data.keyEpoch).toBe(2);
    expect((await as("other", "get", `/planner/meetings/${m._id}`)).status).toBe(404);
    m = rekeyed.body.data;
  });

  test("customers: invited only from your own projects and only if opened to them; never organisers", async () => {
    const invite = (attendees) => as("staff", "post", "/planner/meetings").send({ startAt: at(300), endAt: at(330), enc: enc(), attendees });
    expect((await invite([key(people.staff._id), key(people.cust._id)])).body.errors[0].code).toBe("NOT_INVITABLE"); // not opened yet
    await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: true });
    expect((await invite([key(people.staff._id), key(people.cust._id)])).body.errors[0].code).toBe("NOT_INVITABLE"); // no shared project
    await mongoose.connection.db.collection("conversations").insertOne({
      orgId: org._id,
      type: "group",
      name: "Kitchen",
      members: [{ user: people.staff._id }, { user: people.cust._id }],
      project: { status: "active", customers: [people.cust._id], leadDesigner: people.staff._id }
    });
    expect((await invite([key(people.staff._id), key(people.cust._id)])).status).toBe(201);
    expect((await as("cust", "post", "/planner/meetings").send({ startAt: at(300), endAt: at(330), enc: enc(), attendees: [key(people.cust._id)] })).status).toBe(403);
    await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: false });
  });

  test("the meeting reminder goes once to everyone who hasn't declined", async () => {
    const res = await as("staff", "post", "/planner/meetings").send({
      startAt: at(5),
      endAt: at(35),
      enc: enc(),
      attendees: [key(people.staff._id), key(people.other._id), key(people.admin._id)],
      reminderMinutes: 10
    });
    await as("admin", "post", `/planner/meetings/${res.body.data._id}/respond`).send({ response: "declined" });
    const before = await tenant.runInOrg(org._id, () => Notification.countDocuments({ type: "planner_reminder", title: "Meeting soon" }));
    const now = new Date();
    const [a, b] = await Promise.all([tenant.runInOrg(org._id, () => meetings.processDue(now)), tenant.runInOrg(org._id, () => meetings.processDue(now))]);
    expect(a + b).toBe(1);
    const after = await tenant.runInOrg(org._id, () => Notification.countDocuments({ type: "planner_reminder", title: "Meeting soon" }));
    expect(after - before).toBe(2); // staff + other, not the admin who declined
  });

  test("cancelling keeps it visible as cancelled and tells attendees", async () => {
    const res = await as("staff", "post", "/planner/meetings").send({ startAt: at(400), endAt: at(430), enc: enc(), attendees: [key(people.staff._id), key(people.other._id)] });
    expect((await as("other", "delete", `/planner/meetings/${res.body.data._id}`)).status).toBe(404); // only the organiser
    expect((await as("staff", "delete", `/planner/meetings/${res.body.data._id}`)).status).toBe(200);
    expect((await as("other", "get", `/planner/meetings/${res.body.data._id}`)).body.data.cancelled).toBe(true);
  });
});

describe("people search for invites", () => {
  test("staff find colleagues by name (not only admins); customers can't search", async () => {
    const res = await as("staff", "get", "/planner/people?q=oth");
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.name)).toEqual(["other"]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(["_id", "avatarUrl", "designation", "name", "role"]);
    expect((await as("cust", "get", "/planner/people")).status).toBe(403);
  });

  test("customers of my own projects appear only when the organisation opened the Planner to them", async () => {
    const names = async () => (await as("staff", "get", "/planner/people?q=cus")).body.data.map((p) => p.name);
    expect(await names()).toEqual([]);
    await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: true });
    expect(await names()).toEqual(["cust"]); // shares the "Kitchen" project with staff
    expect((await as("other", "get", "/planner/people?q=cus")).body.data).toEqual([]); // not their project
    await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: false });
  });
});

describe("starting over when the key can't be recovered", () => {
  test("needs the confirmation word, deletes the person's own encrypted items only, and is audited", async () => {
    await as("other", "post", "/planner/notes").send({ enc: enc() });
    const mine = (await as("staff", "get", "/planner/notes")).body.data.items.length;
    expect((await as("other", "delete", "/planner/vault").send({})).status).toBe(400);
    // A session alone isn't enough: the password must be given again
    expect((await as("other", "delete", "/planner/vault").send({ confirm: "DELETE" })).status).toBe(400);
    const wrongKey = deriveAuthKey("Wrong-Pass9", people.other.kdf.salt);
    expect((await as("other", "delete", "/planner/vault").send({ confirm: "DELETE", authKey: wrongKey })).status).toBe(401);
    const res = await as("other", "delete", "/planner/vault").send({ confirm: "DELETE", authKey: deriveAuthKey(PASSWORD, people.other.kdf.salt) });
    expect(res.status).toBe(200);
    expect(res.body.data.notes).toBeGreaterThan(0);
    expect((await as("other", "get", "/planner/notes")).body.data.items).toEqual([]);
    expect((await as("other", "get", "/planner/vault")).body.data.wraps).toBeNull();
    expect((await as("staff", "get", "/planner/notes")).body.data.items.length).toBe(mine); // others untouched
    const AuditLog = require("../src/models/AuditLog");
    expect(await tenant.runInOrg(org._id, () => AuditLog.exists({ action: "planner_reset", targetId: people.other._id }))).toBeTruthy();
  });
});

describe("security review fixes", () => {
  const Meeting = require("../src/modules/planner/models/Meeting");
  const key = (user) => ({ user: String(user), wrapped: wrapped(), recipientKeyVersion: 1, senderKeyVersion: 1 });
  const at = (minutes) => new Date(Date.now() + minutes * 60 * 1000).toISOString();

  beforeAll(async () => {
    await makeUser("cust2", { role: "customer", phone: "+919876543211", phoneVerified: true });
    await login("cust2");
    // cust2 is a customer of a different project of staff ("Bathroom")
    await mongoose.connection.db.collection("conversations").insertOne({
      orgId: org._id,
      type: "group",
      name: "Bathroom",
      members: [{ user: people.staff._id }, { user: people.cust2._id }],
      project: { status: "active", customers: [people.cust2._id], leadDesigner: people.staff._id }
    });
    await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: true });
  });
  afterAll(() => as("boss", "patch", "/org/modules/planner/customers").send({ enabled: false }));

  test("a customer never sees other customers in a meeting (only a count)", async () => {
    const res = await as("staff", "post", "/planner/meetings").send({
      startAt: at(600),
      endAt: at(630),
      enc: enc(),
      attendees: [key(people.staff._id), key(people.cust._id), key(people.cust2._id)]
    });
    expect(res.status).toBe(201);
    const seen = (await as("cust", "get", `/planner/meetings/${res.body.data._id}`)).body.data;
    expect(seen.attendees.map((a) => a.name).sort()).toEqual(["cust", "staff"]);
    expect(seen.hiddenGuests).toBe(1);
    expect(JSON.stringify(seen)).not.toContain(String(people.cust2._id));
    // Staff still see everyone
    expect((await as("staff", "get", `/planner/meetings/${res.body.data._id}`)).body.data.attendees).toHaveLength(3);
  });

  test("busy times only for people you could invite", async () => {
    await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: false });
    const res = await as("staff", "get", `/planner/availability?users=${people.cust._id},${people.other._id}&from=${at(-60)}&to=${at(60 * 24)}`);
    expect(res.body.data.map((r) => r.user)).toEqual([String(people.other._id)]); // customer dropped
    await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: true });
  });

  test("saving a meeting without changing its time keeps answers and doesn't resend the reminder", async () => {
    const m = (await as("staff", "post", "/planner/meetings").send({ startAt: at(5), endAt: at(35), enc: enc(), attendees: [key(people.staff._id), key(people.other._id)], reminderMinutes: 10 })).body.data;
    await as("other", "post", `/planner/meetings/${m._id}/respond`).send({ response: "accepted" });
    await tenant.runInOrg(org._id, () => require("../src/modules/planner/meetings.service").processDue(new Date()));
    const before = await tenant.runInOrg(org._id, () => Meeting.findById(m._id).lean());
    expect(before.reminderSent).toBe(true);
    // Same times resent (as the app does), only the details changed
    const saved = await as("staff", "patch", `/planner/meetings/${m._id}`).send({ version: before.version, startAt: m.startAt, endAt: m.endAt, enc: enc() });
    expect(saved.status).toBe(200);
    expect(saved.body.data.attendees.find((a) => a.user === String(people.other._id)).response).toBe("accepted");
    const after = await tenant.runInOrg(org._id, () => Meeting.findById(m._id).lean());
    expect(after.reminderSent).toBe(true);
  });

  test("a reminder can't point at someone else's note", async () => {
    const theirs = (await as("staff", "post", "/planner/notes").send({ enc: enc() })).body.data;
    const res = await as("other", "post", "/planner/reminders").send({ enc: enc(), at: at(60), link: { kind: "note", id: theirs._id } });
    expect(res.status).toBe(404);
  });

  test("reminders aren't sent to someone who can no longer use the Planner", async () => {
    const reminders = require("../src/modules/planner/reminders.service");
    const Notification = require("../src/models/Notification");
    await as("cust", "post", "/planner/reminders").send({ enc: enc(), at: new Date(Date.now() + 2000).toISOString() });
    await as("boss", "patch", "/org/modules/planner/customers").send({ enabled: false });
    const before = await tenant.runInOrg(org._id, () => Notification.countDocuments({ recipient: people.cust._id, type: "planner_reminder" }));
    await tenant.runInOrg(org._id, () => reminders.processDue(new Date(Date.now() + 10_000)));
    const after = await tenant.runInOrg(org._id, () => Notification.countDocuments({ recipient: people.cust._id, type: "planner_reminder" }));
    expect(after).toBe(before);
  });
});
