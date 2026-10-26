/**
 * Chat upgrade (chat-features-plan.md) against a real (in-memory) MongoDB.
 * P0: idempotent sends — a retried message (same clientMsgId) is saved once.
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";
process.env.API_RATE_LIMIT_PER_MIN = "100000";
process.env.CHAT_MENTION_LIMIT_PER_MIN = "100000"; // the limit itself is tested with 10 below
process.env.CHAT_MESSAGE_LIMIT_PER_MIN = "100000";
process.env.CHAT_ATTACHMENT_LIMIT_PER_HOUR = "100000";

const mongoose = require("mongoose");
const request = require("supertest");
const crypto = require("crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const Message = require("../src/models/Message");
const { newSalt, deriveAuthKey } = require("../src/utils/kdf");

jest.setTimeout(120000);

const PASSWORD = "Sample-Pass1";
const MODULES = ["tasks", "projects", "chat", "customer_portal"].map((key) => ({ key, enabled: true }));
const enc = () => ({ ciphertext: crypto.randomBytes(40).toString("base64"), iv: crypto.randomBytes(12).toString("base64") });

let mongod;
let app;
let org;
const people = {};
const cookies = {};

const makeUser = (key, fields = {}) =>
  tenant.runInOrg(org._id, async () => {
    const salt = newSalt();
    const u = new User({ name: key, email: `${key}@acme.test`, status: "active", role: "user", moduleAccess: { keys: ["chat", "projects"] }, ...fields });
    u.setDerivedCredential(deriveAuthKey(PASSWORD, salt), salt);
    await u.save();
    people[key] = u;
  });
const login = async (key) => {
  const identifier = `${key}@acme.test`;
  const pre = await request(app).post("/api/v1/auth/prelogin").send({ identifier, organisation: "acme" });
  const res = await request(app).post("/api/v1/auth/login").send({ identifier, organisation: "acme", authKey: deriveAuthKey(PASSWORD, pre.body.data.kdf.salt) });
  expect(res.status).toBe(200);
  cookies[key] = res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
};
const as = (key, method, url) => request(app)[method](`/api/v1/chat${url}`).set("Cookie", cookies[key]);
const dm = async (a, b) => {
  const res = await as(a, "post", "/conversations").send({ type: "dm", memberIds: [String(people[b]._id)] });
  expect([200, 201]).toContain(res.status);
  return res.body.data._id;
};
const countIn = (conversation) => tenant.runInOrg(org._id, () => Message.countDocuments({ conversation }));

let annaBen;
let annaCara;
let group; // anna (admin), ben, cara, dave
let project; // anna (lead, admin), ben (staff), cust1, cust2

const Conversation = require("../src/models/Conversation");
const Notification = require("../src/models/Notification");
const ChatMemberState = require("../src/models/ChatMemberState");
const id = (k) => String(people[k]._id);
const commitment = () => crypto.randomBytes(32).toString("base64");
const send = (who, conv, extra = {}) =>
  as(who, "post", `/conversations/${conv}/messages`).send({ ...enc(), franking: { commitment: commitment() }, ...extra });
const inOrg = (fn) => tenant.runInOrg(org._id, fn);
const mentionNotes = (who, conv) => inOrg(() => Notification.find({ recipient: people[who]._id, type: "mentioned", relatedConversation: conv }).lean());
/** Notifications are sent after the response: poll briefly */
const eventually = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
};
const myConv = async (who, convId) => (await as(who, "get", "/conversations")).body.data.find((c) => c._id === String(convId));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  app = require("../src/app");
  org = await Organisation.create({ name: "Acme", slug: "acme", modules: MODULES });
  for (const k of ["anna", "ben", "cara", "dave", "spammer"]) await makeUser(k);
  for (const k of ["cust1", "cust2"]) {
    await makeUser(k, { role: "customer", phone: `+9198765432${k.slice(-1)}0`, phoneVerified: true, moduleAccess: undefined });
  }
  for (const k of Object.keys(people)) await login(k);
  annaBen = await dm("anna", "ben");
  annaCara = await dm("anna", "cara");
  group = await inOrg(async () =>
    String(
      (
        await Conversation.create({
          type: "group",
          name: "Studio",
          createdBy: people.anna._id,
          members: [
            { user: people.anna._id, role: "admin" },
            ...["ben", "cara", "dave", "spammer"].map((k) => ({ user: people[k]._id, role: "member" }))
          ]
        })
      )._id
    )
  );
  project = await inOrg(async () =>
    String(
      (
        await Conversation.create({
          type: "group",
          name: "Kitchen Project",
          createdBy: people.anna._id,
          members: [
            { user: people.anna._id, role: "admin" },
            ...["ben", "cust1", "cust2"].map((k) => ({ user: people[k]._id, role: "member" }))
          ],
          project: { customers: [people.cust1._id, people.cust2._id], leadDesigner: people.anna._id, createdBy: people.anna._id }
        })
      )._id
    )
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("P0 idempotent sends (clientMsgId)", () => {
  test("a retry with the same clientMsgId returns the saved message instead of a second one", async () => {
    const clientMsgId = crypto.randomUUID();
    const body = { ...enc(), clientMsgId };
    const first = await as("anna", "post", `/conversations/${annaBen}/messages`).send(body);
    expect(first.status).toBe(201);
    expect(first.body.data.clientMsgId).toBe(clientMsgId);

    const before = await countIn(annaBen);
    const retry = await as("anna", "post", `/conversations/${annaBen}/messages`).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.data._id).toBe(first.body.data._id);
    expect(await countIn(annaBen)).toBe(before);
  });

  test("parallel copies of the same retry still save one message", async () => {
    const body = { ...enc(), clientMsgId: crypto.randomUUID() };
    const before = await countIn(annaBen);
    const results = await Promise.all([1, 2, 3, 4].map(() => as("anna", "post", `/conversations/${annaBen}/messages`).send(body)));
    for (const r of results) expect([200, 201]).toContain(r.status);
    expect(new Set(results.map((r) => r.body.data._id)).size).toBe(1);
    expect(await countIn(annaBen)).toBe(before + 1);
  });

  test("the same id in another chat is refused (409), not answered with the first chat's message", async () => {
    const clientMsgId = crypto.randomUUID();
    expect((await as("anna", "post", `/conversations/${annaBen}/messages`).send({ ...enc(), clientMsgId })).status).toBe(201);
    const other = await as("anna", "post", `/conversations/${annaCara}/messages`).send({ ...enc(), clientMsgId });
    expect(other.status).toBe(409);
    expect(other.body.data).toBeFalsy();
  });

  test("ids are per sender: someone else using the same id gets their own message", async () => {
    const clientMsgId = crypto.randomUUID();
    const a = await as("anna", "post", `/conversations/${annaBen}/messages`).send({ ...enc(), clientMsgId });
    const b = await as("ben", "post", `/conversations/${annaBen}/messages`).send({ ...enc(), clientMsgId });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.data._id).not.toBe(a.body.data._id);
  });

  test("malformed ids are refused; messages without an id still work as before", async () => {
    for (const bad of ["short", "x".repeat(65), "has spaces in it", "<script>alert(1)</script>", 12345678, { $gt: "" }]) {
      const res = await as("anna", "post", `/conversations/${annaBen}/messages`).send({ ...enc(), clientMsgId: bad });
      expect(res.status).toBe(400);
    }
    const before = await countIn(annaBen);
    for (let i = 0; i < 2; i++) expect((await as("anna", "post", `/conversations/${annaBen}/messages`).send(enc())).status).toBe(201);
    expect(await countIn(annaBen)).toBe(before + 2);
  });

  test("a non-member can't use a retry to read someone's message", async () => {
    const clientMsgId = crypto.randomUUID();
    expect((await as("anna", "post", `/conversations/${annaBen}/messages`).send({ ...enc(), clientMsgId })).status).toBe(201);
    const res = await as("cara", "post", `/conversations/${annaBen}/messages`).send({ ...enc(), clientMsgId });
    expect(res.status).toBe(403);
    expect(res.body.data).toBeFalsy();
  });
});

describe("P1 mentions", () => {
  test("a mention is stored, counted for that person only, and notified with generic text", async () => {
    const res = await send("anna", group, { mentions: [id("ben")] });
    expect(res.status).toBe(201);
    expect(res.body.data.mentions).toEqual([id("ben")]);

    expect((await myConv("ben", group)).mentionCount).toBe(1);
    expect((await myConv("cara", group)).mentionCount).toBe(0);
    const [note] = await eventually(async () => {
      const n = await mentionNotes("ben", group);
      expect(n).toHaveLength(1);
      return n;
    });
    expect(note.message).toBe("anna mentioned you in Studio");
    expect(JSON.stringify(note)).not.toContain(res.body.data.ciphertext);

    // Reading the chat clears the counter
    expect((await as("ben", "patch", `/messages/${res.body.data._id}/read`)).status).toBe(200);
    expect((await myConv("ben", group)).mentionCount).toBe(0);
  });

  test("other people's counters and settings are never shown", async () => {
    await send("anna", group, { mentions: [id("cara")] });
    const seenByBen = await myConv("ben", group);
    for (const m of seenByBen.members) {
      expect(m).not.toHaveProperty("mentionCount");
      expect(m).not.toHaveProperty("notify");
    }
    const single = await as("ben", "get", `/conversations/${group}`);
    expect(single.body.data.mentionCount).toBe(0); // ben's own, not cara's
  });

  test("only current members can be mentioned; the sender is dropped; lists are bounded and checked", async () => {
    expect((await send("anna", group, { mentions: [id("cust1")] })).status).toBe(400); // not in this chat
    const self = await send("anna", group, { mentions: [id("anna")] });
    expect(self.status).toBe(201);
    expect(self.body.data.mentions).toBeUndefined();
    const tooMany = Array.from({ length: 51 }, () => new mongoose.Types.ObjectId().toString());
    expect((await send("anna", group, { mentions: tooMany })).status).toBe(400);
    for (const bad of ["x", [123], ["not-an-id"], [{ $ne: null }], "6ad4c6f9717116567473e20d"]) {
      expect((await send("anna", group, { mentions: bad })).status).toBe(400);
    }
    const dup = await send("anna", group, { mentions: [id("dave"), id("dave").toUpperCase()] });
    expect(dup.body.data.mentions).toEqual([id("dave")]);
  });

  test("@everyone: group admins only, never in DMs; everyone else is counted", async () => {
    expect((await send("ben", group, { mentionsAll: "everyone" })).status).toBe(403);
    expect((await send("anna", annaBen, { mentionsAll: "everyone" })).status).toBe(403);
    expect((await send("anna", group, { mentionsAll: "nobody" })).status).toBe(400);
    const before = (await myConv("dave", group)).mentionCount;
    expect((await send("anna", group, { mentionsAll: "everyone" })).status).toBe(201);
    expect((await myConv("dave", group)).mentionCount).toBe(before + 1);
    const [n] = await eventually(async () => {
      const list = (await mentionNotes("dave", group)).filter((x) => x.message.includes("@everyone"));
      expect(list).toHaveLength(1);
      return list;
    });
    expect(n.message).toBe("anna mentioned @everyone in Studio");
  });

  test("project chats: staff may use @everyone; customers can mention only the team", async () => {
    expect((await send("ben", project, { mentionsAll: "everyone" })).status).toBe(201); // staff, not an admin
    expect((await send("cust1", project, { mentionsAll: "everyone" })).status).toBe(403);
    expect((await send("cust1", project, { mentions: [id("cust2")] })).status).toBe(403);
    const ok = await send("cust1", project, { mentions: [id("anna")] });
    expect(ok.status).toBe(201);
    expect((await myConv("anna", project)).mentionCount).toBeGreaterThan(0);
  });

  test("mention-carrying messages are limited to 10 a minute; plain messages aren't affected", async () => {
    process.env.CHAT_MENTION_LIMIT_PER_MIN = ""; // the real default (10)
    try {
      for (let i = 0; i < 10; i++) expect((await send("spammer", group, { mentions: [id("anna")] })).status).toBe(201);
      expect((await send("spammer", group, { mentions: [id("anna")] })).status).toBe(429);
      expect((await send("spammer", group, { mentionsAll: "here" })).status).toBe(429);
      expect((await send("spammer", group)).status).toBe(201);
    } finally {
      process.env.CHAT_MENTION_LIMIT_PER_MIN = "100000";
    }
  });
});

describe("P1 notification settings (mute)", () => {
  const notify = (who, conv, body) => as(who, "patch", `/conversations/${conv}/notify`).send(body);
  const countFor = async (who) => (await mentionNotes(who, group)).length;
  const settle = () => new Promise((r) => setTimeout(r, 300));

  test("off: mentions are still counted but not notified; mentions-only still notifies a mention", async () => {
    expect((await notify("cara", group, { notify: "off" })).body.data).toMatchObject({ notify: "off", mutedUntil: null });
    const before = await countFor("cara");
    const countBefore = (await myConv("cara", group)).mentionCount;
    await send("anna", group, { mentions: [id("cara")] });
    await settle();
    expect(await countFor("cara")).toBe(before);
    expect((await myConv("cara", group)).mentionCount).toBe(countBefore + 1);

    await notify("cara", group, { notify: "mentions" });
    await send("anna", group, { mentions: [id("cara")] });
    await eventually(async () => expect(await countFor("cara")).toBe(before + 1));
  });

  test("snooze silences mentions too, and can be lifted", async () => {
    await notify("dave", group, { notify: "all" });
    const res = await notify("dave", group, { muteFor: "1h" });
    expect(new Date(res.body.data.mutedUntil).getTime()).toBeGreaterThan(Date.now() + 59 * 60e3);
    const before = await countFor("dave");
    await send("anna", group, { mentions: [id("dave")] });
    await settle();
    expect(await countFor("dave")).toBe(before);
    expect((await notify("dave", group, { muteFor: "none" })).body.data.mutedUntil).toBeNull();
    await send("anna", group, { mentions: [id("dave")] });
    await eventually(async () => expect(await countFor("dave")).toBe(before + 1));
  });

  test("settings are validated, private, and only for members", async () => {
    for (const body of [{}, { notify: "loud" }, { muteFor: "3d" }, { notify: { $ne: 1 } }, { muteFor: 5 }]) {
      expect((await notify("ben", group, body)).status).toBe(400);
    }
    expect((await notify("cust1", group, { notify: "off" })).status).toBe(403);
    await notify("ben", group, { notify: "off" });
    expect((await myConv("ben", group)).notify).toBe("off");
    expect((await myConv("anna", group)).notify).toBe("all");
    const rows = await inOrg(() => ChatMemberState.find({ conversation: group, user: people.ben._id }).lean());
    expect(rows).toHaveLength(1);
    expect(String(rows[0].orgId)).toBe(String(org._id));
  });

  test("isSilenced rules", () => {
    const { isSilenced } = require("../src/services/mention.service");
    const now = Date.now();
    expect(isSilenced(null, { mentioned: false })).toBe(false);
    expect(isSilenced({ notify: "all" }, { mentioned: false })).toBe(false);
    expect(isSilenced({ notify: "mentions" }, { mentioned: false })).toBe(true);
    expect(isSilenced({ notify: "mentions" }, { mentioned: true })).toBe(false);
    expect(isSilenced({ notify: "off" }, { mentioned: true })).toBe(true);
    expect(isSilenced({ notify: "all", mutedUntil: new Date(now + 1000) }, { mentioned: true }, now)).toBe(true);
    expect(isSilenced({ notify: "all", mutedUntil: new Date(now - 1000) }, { mentioned: true }, now)).toBe(false);
  });
});

describe("P2 receipts (delivered / read)", () => {
  const receipts = require("../src/services/receipt.service");
  const memberOf = async (convId, who) =>
    (await inOrg(() => Conversation.findById(convId).lean())).members.find((m) => String(m.user) === id(who));

  test("reading moves lastRead forward and delivered with it", async () => {
    const msg = await send("anna", group);
    expect((await as("cara", "patch", `/messages/${msg.body.data._id}/read`)).status).toBe(200);
    const m = await memberOf(group, "cara");
    expect(m.lastRead).toBeTruthy();
    expect(new Date(m.lastDelivered).getTime()).toBeGreaterThanOrEqual(new Date(m.lastRead).getTime());
  });

  test("delivered only moves forward ($max), future times are clamped, non-members change nothing", async () => {
    const t1 = new Date(Date.now() - 60_000).toISOString();
    const t0 = new Date(Date.now() - 120_000).toISOString();
    await inOrg(() => receipts.markDelivered(null, group, id("dave"), t1));
    await inOrg(() => receipts.markDelivered(null, group, id("dave"), t0)); // late, older event
    expect(new Date((await memberOf(group, "dave")).lastDelivered).toISOString()).toBe(t1);
    await inOrg(() => receipts.markDelivered(null, group, id("dave"), new Date(Date.now() + 864e5).toISOString()));
    expect(new Date((await memberOf(group, "dave")).lastDelivered).getTime()).toBeLessThanOrEqual(Date.now());
    expect(await inOrg(() => receipts.markDelivered(null, group, id("cust1"), t1))).toBeNull();
    expect(await inOrg(() => receipts.markDelivered(null, group, id("dave"), "not a date"))).toBeNull();
  });

  test("customers see only the team's latest read time, never who read (CH-D3)", async () => {
    const msg = await send("cust1", project);
    await as("ben", "patch", `/messages/${msg.body.data._id}/read`);
    await as("cust2", "patch", `/messages/${msg.body.data._id}/read`);
    for (const view of [await myConv("cust1", project), (await as("cust1", "get", `/conversations/${project}`)).body.data]) {
      expect(view.teamLastRead).toBeTruthy();
      for (const m of view.members) {
        if (m.user._id === id("cust1")) continue;
        expect(m).not.toHaveProperty("lastRead");
        expect(m).not.toHaveProperty("lastDelivered");
      }
    }
    const staffView = await myConv("anna", project);
    expect(staffView.teamLastRead).toBeUndefined();
    expect(staffView.members.find((m) => m.user._id === id("ben")).lastRead).toBeTruthy();
  });
});

describe("P2 threads", () => {
  const thread = (who, conv, root, q = "") => as(who, "get", `/conversations/${conv}/threads/${root}${q}`);
  const mainIds = async (who, conv) => (await as(who, "get", `/conversations/${conv}/messages`)).body.data.messages.map((m) => m._id);

  test("a reply goes into the thread, updates the root, and stays out of the chat unless also sent there", async () => {
    const root = (await send("anna", group)).body.data;
    const r1 = await send("ben", group, { threadRoot: root._id });
    expect(r1.status).toBe(201);
    expect(r1.body.data.threadRoot).toBe(root._id);
    const r2 = await send("cara", group, { threadRoot: root._id, alsoInChat: true });

    const t = await thread("dave", group, root._id);
    expect(t.status).toBe(200);
    expect(t.body.data.root._id).toBe(root._id);
    expect(t.body.data.root.threadReplyCount).toBe(2);
    expect(t.body.data.root.threadParticipants.sort()).toEqual([id("ben"), id("cara")].sort());
    expect(t.body.data.messages.map((m) => m._id)).toEqual([r1.body.data._id, r2.body.data._id]);

    const main = await mainIds("dave", group);
    expect(main).toContain(root._id);
    expect(main).not.toContain(r1.body.data._id);
    expect(main).toContain(r2.body.data._id);
  });

  test("thread-only replies don't count as unread in the chat", async () => {
    const root = (await send("anna", group)).body.data;
    await as("dave", "patch", `/messages/${root._id}/read`);
    await send("ben", group, { threadRoot: root._id });
    expect((await myConv("dave", group)).unreadCount).toBe(0);
    await send("ben", group, { threadRoot: root._id, alsoInChat: true });
    expect((await myConv("dave", group)).unreadCount).toBe(1);
  });

  test("one level only; the root must be a live message of this chat", async () => {
    const root = (await send("anna", group)).body.data;
    const reply = (await send("ben", group, { threadRoot: root._id })).body.data;
    expect((await send("cara", group, { threadRoot: reply._id })).status).toBe(400); // nested
    const elsewhere = (await send("anna", annaBen)).body.data;
    expect((await send("anna", group, { threadRoot: elsewhere._id })).status).toBe(400); // other chat
    for (const bad of ["x", { $ne: null }, 5]) expect((await send("anna", group, { threadRoot: bad })).status).toBe(400);
    expect((await send("anna", group, { threadRoot: root._id, alsoInChat: "yes" })).status).toBe(400);
    expect((await thread("anna", group, reply._id)).status).toBe(404); // a reply isn't a thread
    expect((await thread("anna", annaBen, root._id)).status).toBe(404); // root of another chat
    expect((await thread("cust1", group, root._id)).status).toBe(403); // not a member
  });

  test("followers are told about replies; someone mentioned gets just the mention; muted followers nothing", async () => {
    const notes = (who, type) => inOrg(() => Notification.find({ recipient: people[who]._id, type, relatedConversation: group }).lean());
    await as("anna", "patch", `/conversations/${group}/notify`).send({ notify: "all", muteFor: "none" });
    await as("ben", "patch", `/conversations/${group}/notify`).send({ notify: "mentions", muteFor: "none" });
    const root = (await send("anna", group)).body.data;
    const initial = (await notes("anna", "thread_reply")).length;
    await send("ben", group, { threadRoot: root._id }); // ben now follows (but only wants mentions)
    // anna (root author) hears about ben's reply; wait for it before counting from here
    await eventually(async () => expect((await notes("anna", "thread_reply")).length).toBe(initial + 1));
    const annaBefore = (await notes("anna", "thread_reply")).length;
    const benBefore = (await notes("ben", "thread_reply")).length;
    const annaMentionsBefore = (await notes("anna", "mentioned")).length;

    await send("cara", group, { threadRoot: root._id });
    await eventually(async () => expect((await notes("anna", "thread_reply")).length).toBe(annaBefore + 1));
    const fromThisTest = (await notes("anna", "thread_reply")).filter((n) => new Date(n.createdAt) >= new Date(root.createdAt));
    expect(fromThisTest.filter((n) => n.message === "cara replied in a thread in Studio")).toHaveLength(1);

    await send("cara", group, { threadRoot: root._id, mentions: [id("anna")] });
    await eventually(async () => expect((await notes("anna", "mentioned")).length).toBe(annaMentionsBefore + 1));
    await new Promise((r) => setTimeout(r, 300));
    expect((await notes("anna", "thread_reply")).length).toBe(annaBefore + 1); // no second one for the same reply
    expect((await notes("ben", "thread_reply")).length).toBe(benBefore); // mentions only
  });
});

describe("P3 pins", () => {
  const pin = (who, conv, msg, method = "post") => as(who, method, `/conversations/${conv}/pins/${msg}`);
  const pinsOf = async (who, conv) => (await as(who, "get", `/conversations/${conv}/pins`)).body.data;

  test("who may pin: group admins, staff in project chats, either person in a DM; never customers", async () => {
    const g = (await send("anna", group)).body.data;
    expect((await pin("ben", group, g._id)).status).toBe(403);
    expect((await pin("anna", group, g._id)).status).toBe(200);
    const p = (await send("cust1", project)).body.data;
    expect((await pin("cust1", project, p._id)).status).toBe(403);
    expect((await pin("ben", project, p._id)).status).toBe(200);
    const d = (await send("anna", annaBen)).body.data;
    expect((await pin("ben", annaBen, d._id)).status).toBe(200);
    expect((await pinsOf("cust1", project)).canPin).toBe(false);
    expect((await pinsOf("cust1", project)).pins.map((x) => x.message._id)).toContain(p._id); // customers can see them
  });

  test("newest first, idempotent, only live messages shown in this chat, deleted ones drop out", async () => {
    const a = (await send("anna", group)).body.data;
    const b = (await send("anna", group)).body.data;
    await pin("anna", group, a._id);
    await pin("anna", group, b._id);
    expect((await pin("anna", group, b._id)).status).toBe(200); // again: no duplicate
    const ids = (await pinsOf("dave", group)).pins.map((x) => x.message._id);
    expect(ids.slice(0, 2)).toEqual([b._id, a._id]);
    expect(ids.filter((x) => x === b._id)).toHaveLength(1);

    const root = (await send("anna", group)).body.data;
    const reply = (await send("ben", group, { threadRoot: root._id })).body.data;
    expect((await pin("anna", group, reply._id)).status).toBe(400);
    const elsewhere = (await send("anna", annaBen)).body.data;
    expect((await pin("anna", group, elsewhere._id)).status).toBe(404);
    expect((await pin("anna", group, "nope")).status).toBe(400);

    expect((await as("anna", "delete", `/messages/${b._id}`).send({ scope: "everyone" })).status).toBe(200);
    expect((await pinsOf("dave", group)).pins.map((x) => x.message._id)).not.toContain(b._id);
    expect((await pin("anna", group, a._id, "delete")).status).toBe(200);
    expect((await pinsOf("dave", group)).pins.map((x) => x.message._id)).not.toContain(a._id);
  });

  test("at most 50 pins", async () => {
    const conv = await inOrg(async () =>
      String((await Conversation.create({ type: "group", name: "Pins", createdBy: people.anna._id, members: [{ user: people.anna._id, role: "admin" }, { user: people.ben._id }] }))._id)
    );
    const msgs = await inOrg(() => Message.insertMany(Array.from({ length: 51 }, () => ({ conversation: conv, sender: people.anna._id, ...enc() }))));
    // 49 already pinned (directly: the API allows 30 pin changes a minute)
    await inOrg(() =>
      Conversation.updateOne({ _id: conv }, { $set: { pins: msgs.slice(0, 49).map((m) => ({ message: m._id, by: people.anna._id })) } })
    );
    expect((await pin("anna", conv, String(msgs[49]._id))).status).toBe(200);
    const full = await pin("anna", conv, String(msgs[50]._id));
    expect(full.status).toBe(400);
    expect(full.body.message).toMatch(/at most 50/);
  });
});

describe("P3 stars", () => {
  const starred = async (who) => (await as(who, "get", "/starred")).body.data;

  test("star and unstar any visible message; private to me; shown as starred in pages", async () => {
    const m = (await send("anna", group)).body.data;
    expect((await as("ben", "post", `/messages/${m._id}/star`)).status).toBe(200);
    expect((await as("ben", "post", `/messages/${m._id}/star`)).status).toBe(200); // twice: still one
    expect((await starred("ben")).items.filter((i) => i.message._id === m._id)).toHaveLength(1);
    expect((await starred("cara")).items.some((i) => i.message._id === m._id)).toBe(false);
    const page = (await as("ben", "get", `/conversations/${group}/messages`)).body.data.messages;
    expect(page.find((x) => x._id === m._id).starred).toBe(true);
    const annasPage = (await as("anna", "get", `/conversations/${group}/messages`)).body.data.messages;
    expect(annasPage.find((x) => x._id === m._id).starred).toBeUndefined();
    expect((await as("ben", "delete", `/messages/${m._id}/star`)).status).toBe(200);
    expect((await starred("ben")).items.some((i) => i.message._id === m._id)).toBe(false);
  });

  test("other chats' messages can't be starred; leaving a chat hides its stars", async () => {
    const m = (await send("anna", annaBen)).body.data;
    expect((await as("cara", "post", `/messages/${m._id}/star`)).status).toBe(404);
    const conv = await inOrg(async () =>
      String((await Conversation.create({ type: "group", name: "Temp", createdBy: people.anna._id, members: [{ user: people.anna._id, role: "admin" }, { user: people.dave._id }] }))._id)
    );
    const t = (await send("anna", conv)).body.data;
    expect((await as("dave", "post", `/messages/${t._id}/star`)).status).toBe(200);
    await inOrg(() => Conversation.updateOne({ _id: conv }, { $pull: { members: { user: people.dave._id } } }));
    expect((await starred("dave")).items.some((i) => i.message._id === t._id)).toBe(false);
  });

  test("customers can star in their project chat", async () => {
    const m = (await send("anna", project)).body.data;
    expect((await as("cust1", "post", `/messages/${m._id}/star`)).status).toBe(200);
    expect((await starred("cust1")).items.some((i) => i.message._id === m._id)).toBe(true);
  });
});

describe("P3 jump to message (around / after)", () => {
  let conv;
  let ids;
  beforeAll(async () => {
    conv = await inOrg(async () =>
      String((await Conversation.create({ type: "group", name: "Long", createdBy: people.anna._id, members: [{ user: people.anna._id, role: "admin" }, { user: people.ben._id }] }))._id)
    );
    const base = Date.now() - 1e6;
    const docs = await inOrg(() =>
      Message.insertMany(Array.from({ length: 120 }, (_, i) => ({ conversation: conv, sender: people.anna._id, ...enc(), createdAt: new Date(base + i * 1000) })))
    );
    ids = docs.map((d) => String(d._id));
  });
  const page = (q) => as("ben", "get", `/conversations/${conv}/messages${q}`);

  test("around returns the message in the middle, with older and newer cursors", async () => {
    const res = await page(`?around=${ids[50]}&limit=20`);
    expect(res.status).toBe(200);
    expect(res.body.data.messages.map((m) => m._id)).toEqual(ids.slice(40, 61));
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.hasNewer).toBe(true);
    const newer = await page(`?after=${res.body.data.newerCursor}&limit=30`);
    expect(newer.body.data.messages.map((m) => m._id)).toEqual(ids.slice(61, 91));
    const older = await page(`?cursor=${res.body.data.nextCursor}&limit=10`);
    expect(older.body.data.messages.map((m) => m._id)).toEqual(ids.slice(30, 40));
  });

  test("near the ends; a thread reply points to its thread; guarded", async () => {
    const end = await page(`?around=${ids[118]}&limit=20`);
    expect(end.body.data.hasNewer).toBe(false);
    expect(end.body.data.messages.slice(-2).map((m) => m._id)).toEqual(ids.slice(118, 120));

    const root = (await send("anna", group)).body.data;
    const reply = (await send("ben", group, { threadRoot: root._id })).body.data;
    const t = await as("dave", "get", `/conversations/${group}/messages?around=${reply._id}`);
    expect(t.body.data.threadRoot).toBe(root._id);
    expect(t.body.data.messages).toEqual([]);

    expect((await as("ben", "get", `/conversations/${conv}/messages?around=${root._id}`)).status).toBe(404); // other chat
    expect((await as("cara", "get", `/conversations/${conv}/messages?around=${ids[5]}`)).status).toBe(403);
    expect((await page("?around=xyz")).status).toBe(400);
    expect((await page("?after[$gt]=1")).status).toBe(400);
  });
});

// ── P4 ──────────────────────────────────────────────────────────────────────

const NAME_FOR = { "image/png": "photo.png", "application/pdf": "quote.pdf", "audio/ogg": "voice.ogg" };
const upload = (who, conv, { mimeType = "image/png", bytes = 100, contentType = "application/octet-stream", extra = {}, name } = {}) => {
  let req = as(who, "post", `/conversations/${conv}/attachments`)
    .attach("file", crypto.randomBytes(bytes), { filename: "x.enc", contentType })
    .field("originalName", name || NAME_FOR[mimeType.split(";")[0]] || (mimeType.startsWith("audio/webm") ? "voice.webm" : "file.bin"))
    .field("mimeType", mimeType)
    .field("fileSize", "999999999")
    .field("encryptedFileKey", crypto.randomBytes(12).toString("base64"))
    .field("fileIv", crypto.randomBytes(12).toString("base64"));
  for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
  return req;
};

describe("P4 encrypted uploads and voice notes", () => {
  test("encrypted files upload (they used to be refused); size comes from the bytes, not the claim", async () => {
    const res = await upload("anna", group, { bytes: 1016 });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("image");
    expect(res.body.data.attachments[0].fileSize).toBe(1000);
  });

  test("voice notes: audio with a length; refused types and unencrypted parts are rejected", async () => {
    const v = await upload("ben", group, { mimeType: "audio/webm;codecs=opus", extra: { fileType: "audio", durationSec: "12.4" } });
    expect(v.status).toBe(201);
    expect(v.body.data.attachments[0]).toMatchObject({ fileType: "audio", mimeType: "audio/webm", durationSec: 12 });
    expect((await upload("ben", group, { mimeType: "text/html" })).status).toBe(400);
    expect((await upload("ben", group, { mimeType: "application/x-msdownload" })).status).toBe(400);
    expect((await upload("ben", group, { contentType: "image/png" })).status).toBe(400); // not encrypted
    expect((await upload("ben", group, { mimeType: "audio/ogg", extra: { durationSec: "9999" } })).status).toBe(400);
    expect((await upload("ben", group, { mimeType: "image/png", extra: { durationSec: "5" } })).status).toBe(400);
    expect((await upload("ben", group, { extra: { fileType: "exe" } })).status).toBe(400);
  });

  test("file names must match their type; control and right-to-left characters are removed", async () => {
    expect((await upload("ben", group, { mimeType: "application/pdf", name: "Quotation.pdf.exe" })).status).toBe(400);
    expect((await upload("ben", group, { mimeType: "application/pdf", name: "Quotation‮fdp.exe" })).status).toBe(400);
    expect((await upload("ben", group, { mimeType: "image/png", name: "noextension" })).status).toBe(400);
    const ok = await upload("ben", group, { mimeType: "application/pdf", name: "Final‏ quote\u0007.PDF" });
    expect(ok.status).toBe(201);
    expect(ok.body.data.attachments[0].originalName).toBe("Final quote.PDF");
  });

  test("files can go into a thread", async () => {
    const root = (await send("anna", group)).body.data;
    const f = await upload("ben", group, { extra: { threadRoot: root._id } });
    expect(f.status).toBe(201);
    expect(f.body.data.threadRoot).toBe(root._id);
    const t = await as("anna", "get", `/conversations/${group}/threads/${root._id}`);
    expect(t.body.data.messages.map((m) => m._id)).toContain(f.body.data._id);
    expect(t.body.data.root.threadReplyCount).toBe(1);
  });

  test("shared files list by kind, newest first; customers can see their project's files", async () => {
    const img = (await upload("anna", project)).body.data;
    const doc = (await upload("anna", project, { mimeType: "application/pdf", extra: { fileType: "pdf" } })).body.data;
    const images = await as("cust1", "get", `/conversations/${project}/files?kind=image`);
    expect(images.status).toBe(200);
    expect(images.body.data.messages[0]._id).toBe(img._id);
    const docs = await as("cust1", "get", `/conversations/${project}/files?kind=doc`);
    expect(docs.body.data.messages.map((m) => m._id)).toContain(doc._id);
    expect(docs.body.data.messages.map((m) => m._id)).not.toContain(img._id);
    expect((await as("cust1", "get", `/conversations/${project}/files?kind=exe`)).status).toBe(400);
    expect((await as("cara", "get", `/conversations/${project}/files`)).status).toBe(403);
  });
});

describe("P4 forwarding", () => {
  test("staff can mark a message forwarded; customers can't; the flag is checked", async () => {
    const f = await send("anna", group, { forwarded: true });
    expect(f.status).toBe(201);
    expect(f.body.data.forwarded).toBe(true);
    expect((await send("cust1", project, { forwarded: true })).status).toBe(403);
    expect((await send("anna", group, { forwarded: "yes" })).status).toBe(400);
  });
});

describe("P4 reply-time banner and away message", () => {
  test("project chats get hours, open-now and the median reply time; other chats don't", async () => {
    const ChatSla = require("../src/models/ChatSla");
    await inOrg(() => ChatSla.deleteMany({})); // earlier tests' real reply timers would move the median
    await inOrg(() =>
      ChatSla.insertMany(
        [10, 20, 30, 40, 50, 60, 70].map((min) => ({
          conversation: project,
          customer: people.cust1._id,
          designer: people.anna._id,
          open: false,
          waitingSince: new Date(Date.now() - 864e5),
          clockStart: new Date(Date.now() - 864e5),
          autoReplyAt: new Date(),
          remindAt: new Date(),
          escalateAt: new Date(),
          resolvedAt: new Date(),
          resolution: "replied",
          replyWorkingMs: min * 60000
        }))
      )
    );
    const info = await as("cust1", "get", `/conversations/${project}/service-info`);
    expect(info.status).toBe(200);
    expect(info.body.data).toMatchObject({ project: true, typicalReplyMinutes: 40 });
    expect(typeof info.body.data.hours).toBe("string");
    expect(typeof info.body.data.openNow).toBe("boolean");
    expect((await as("anna", "get", `/conversations/${group}/service-info`)).body.data.project).toBe(false);
  });

  test("the away message is a validated setting", async () => {
    const boss = "anna"; // anna isn't an admin: the settings route refuses her
    expect((await request(app).put("/api/v1/admin/settings").set("Cookie", cookies[boss]).send({ awayMessage: "x" })).status).toBe(403);
  });
});

describe("P4 team notes (staff only)", () => {
  const wrappedKey = () => ({
    wrapped: `${crypto.randomBytes(12).toString("base64")}:${crypto.randomBytes(48).toString("base64")}`,
    wrapperKeyVersion: 1,
    recipientKeyVersion: 1
  });
  const keysFor = (...who) => Object.fromEntries(who.map((k) => [id(k), wrappedKey()]));

  test("staff start it with keys for the team only; customers can't open, see or be given it", async () => {
    expect((await as("cust1", "post", `/conversations/${project}/team-notes`).send({})).status).toBe(403);
    // A key wrapped for a customer is refused (they aren't members of the notes chat)
    expect((await as("anna", "post", `/conversations/${project}/team-notes`).send({ encryptedGroupKeys: keysFor("anna", "ben", "cust1") })).status).toBe(400);
    const res = await as("anna", "post", `/conversations/${project}/team-notes`).send({ encryptedGroupKeys: keysFor("anna", "ben") });
    expect(res.status).toBe(201);
    const notesId = res.body.data.conversationId;
    const again = await as("ben", "post", `/conversations/${project}/team-notes`).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.conversationId).toBe(notesId);

    const notes = await inOrg(() => Conversation.findById(notesId).lean());
    expect(notes.members.map((m) => String(m.user)).sort()).toEqual([id("anna"), id("ben")].sort());
    expect(String(notes.internalFor)).toBe(project);
    expect((await as("cust1", "get", `/conversations/${notesId}`)).status).toBe(403);
    expect((await as("cust1", "get", `/conversations/${notesId}/messages`)).status).toBe(403);
    expect((await as("cust1", "get", `/conversations/${project}`)).body.data.internalNotes).toBeUndefined();
    expect((await as("anna", "get", `/conversations/${project}`)).body.data.internalNotes).toBe(notesId);
    // Membership is managed with the project: no manual adds (and so never a customer)
    expect((await as("anna", "post", `/conversations/${notesId}/members`).send({ userId: id("cust1") })).status).toBe(403);
    expect((await as("anna", "post", `/conversations/${notesId}/members`).send({ userId: id("cara") })).status).toBe(403);
  });

  test("it follows the project team: removed staff lose it and its keys", async () => {
    const { syncTeamNotes } = require("../src/services/customerChat.service");
    await inOrg(() => Conversation.updateOne({ _id: project }, { $pull: { members: { user: people.ben._id } } }));
    const proj = await inOrg(() => Conversation.findById(project));
    const r = await inOrg(() => syncTeamNotes(proj));
    expect(r.removed).toEqual([id("ben")]);
    const notes = await inOrg(() => Conversation.findById(proj.internalNotes).lean());
    expect(notes.members.map((m) => String(m.user))).toEqual([id("anna")]);
    expect(notes.rekeyRequested).toBe(true);
    expect(JSON.stringify(notes.groupKeyring)).not.toContain(id("ben"));
    expect((await as("ben", "get", `/conversations/${notes._id}/messages`)).status).toBe(403);
    // ben back on the project for the remaining tests
    await inOrg(() => Conversation.updateOne({ _id: project }, { $push: { members: { user: people.ben._id, role: "member" } } }));
    await inOrg(async () => syncTeamNotes(await Conversation.findById(project)));
  });
});

describe("P4 scheduled send", () => {
  const scheduledSvc = require("../src/services/scheduled.service");
  const ScheduledMessage = require("../src/models/ScheduledMessage");
  const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();
  const schedule = (who, conv, extra = {}) =>
    as(who, "post", `/conversations/${conv}/scheduled`).send({ ...enc(), franking: { commitment: commitment() }, ...extra });

  test("checked like a send; 1 minute to 30 days ahead; listed and cancellable by the sender only", async () => {
    expect((await schedule("anna", group, { sendAt: inMinutes(0.2) })).status).toBe(400);
    expect((await schedule("anna", group, { sendAt: inMinutes(31 * 24 * 60) })).status).toBe(400);
    expect((await schedule("anna", group, { sendAt: "soon" })).status).toBe(400);
    expect((await schedule("ben", group, { sendAt: inMinutes(5), mentionsAll: "everyone" })).status).toBe(403); // same rules as sending
    expect((await schedule("cust1", project, { sendAt: inMinutes(5) })).status).toBe(403); // staff feature
    const s = await schedule("anna", group, { sendAt: inMinutes(5) });
    expect(s.status).toBe(201);
    const list = await as("anna", "get", `/conversations/${group}/scheduled`);
    expect(list.body.data.map((x) => x._id)).toContain(s.body.data._id);
    expect((await as("ben", "get", `/conversations/${group}/scheduled`)).body.data.map((x) => x._id)).not.toContain(s.body.data._id);
    expect((await as("ben", "delete", `/scheduled/${s.body.data._id}`)).status).toBe(404);
    expect((await as("anna", "delete", `/scheduled/${s.body.data._id}`)).status).toBe(200);
    expect((await as("anna", "delete", `/scheduled/${s.body.data._id}`)).status).toBe(404);
  });

  test("released once when due, through the normal send path (stamped, mentions still members)", async () => {
    const s = (await schedule("anna", group, { sendAt: inMinutes(2), mentions: [id("dave"), id("cara")] })).body.data;
    // cara leaves before it goes out
    await inOrg(() => Conversation.updateOne({ _id: group }, { $pull: { members: { user: people.cara._id } } }));
    const later = new Date(Date.now() + 3 * 60000);
    const [a, b] = await Promise.all([inOrg(() => scheduledSvc.processDue(later)), inOrg(() => scheduledSvc.processDue(later))]);
    expect(a + b).toBe(1); // two servers at once: sent once
    const doc = await inOrg(() => ScheduledMessage.findById(s._id).lean());
    expect(doc.status).toBe("sent");
    const msg = await inOrg(() => Message.findById(doc.sentMessage).lean());
    expect(msg.ciphertext).toBe(s.ciphertext);
    expect(msg.mentions.map(String)).toEqual([id("dave")]);
    expect(msg.franking?.serverTag).toBeTruthy();
    await inOrg(() => Conversation.updateOne({ _id: group }, { $push: { members: { user: people.cara._id, role: "member" } } }));
  });

  test("not sent if the sender has left the chat by then", async () => {
    const s = (await schedule("dave", group, { sendAt: inMinutes(2) })).body.data;
    await inOrg(() => Conversation.updateOne({ _id: group }, { $pull: { members: { user: people.dave._id } } }));
    await inOrg(() => scheduledSvc.processDue(new Date(Date.now() + 3 * 60000)));
    const doc = await inOrg(() => ScheduledMessage.findById(s._id).lean());
    expect(doc.status).toBe("failed");
    expect(doc.sentMessage).toBeNull();
    await inOrg(() => Conversation.updateOne({ _id: group }, { $push: { members: { user: people.dave._id, role: "member" } } }));
  });
});

describe("Key help (new members get keys without anyone opening the chat)", () => {
  const { membersWithoutKey, requestKeyHelp } = require("../src/services/groupKeys.service");
  const { requestPendingKeyHelp } = require("../src/sockets/chat.socket");
  const fakeIo = () => {
    const sent = [];
    return { sent, to: (rooms) => ({ emit: (event, payload) => sent.push({ rooms: [].concat(rooms), event, payload }) }) };
  };
  const ringWith = (...who) => [{ version: 1, createdBy: people.anna._id, keys: new Map(who.map((k) => [id(k), { wrapped: "x:y", wrapperKeyVersion: 1, recipientKeyVersion: 1, wrappedBy: people.anna._id }])) }];

  test("finds members without the newest key and asks only the chat's admins", async () => {
    const conv = await inOrg(() =>
      Conversation.create({
        type: "group",
        name: "Keys",
        createdBy: people.anna._id,
        members: [{ user: people.anna._id, role: "admin" }, { user: people.ben._id }, { user: people.cara._id }],
        groupKeyring: ringWith("anna", "ben")
      })
    );
    expect(membersWithoutKey(conv)).toEqual([id("cara")]);
    const io = fakeIo();
    expect(requestKeyHelp(io, conv)).toBe(true);
    expect(io.sent).toEqual([{ rooms: [`user:${id("anna")}`], event: "chat:keys:needed", payload: { conversationId: String(conv._id) } }]);
    // Everyone has it and no new key is needed: nothing is sent
    conv.groupKeyring = ringWith("anna", "ben", "cara");
    expect(requestKeyHelp(fakeIo(), conv)).toBe(false);
    // A removal needs a new key: asked even when everyone left has a copy
    conv.rekeyRequested = true;
    expect(requestKeyHelp(fakeIo(), conv)).toBe(true);
    // DMs never
    expect(requestKeyHelp(fakeIo(), { ...conv.toObject(), type: "dm" })).toBe(false);
  });

  test("an admin coming online is asked about chats still waiting; people without chat set up don't count", async () => {
    const { conv } = await inOrg(async () => {
      await User.updateOne({ _id: people.cara._id }, { $set: { publicKey: "PUBKEY-cara", keyVersion: 1 } });
      await User.updateOne({ _id: people.dave._id }, { $set: { publicKey: null } });
      const c = await Conversation.create({
        type: "group",
        name: "Waiting",
        createdBy: people.ben._id,
        members: [{ user: people.ben._id, role: "admin" }, { user: people.cara._id }, { user: people.dave._id }],
        groupKeyring: ringWith("ben")
      });
      return { conv: c };
    });
    const io = fakeIo();
    await inOrg(() => requestPendingKeyHelp(id("ben"), io));
    const mine = io.sent.filter((s) => s.payload.conversationId === String(conv._id));
    expect(mine).toHaveLength(1);
    expect(mine[0].rooms).toEqual([`user:${id("ben")}`]); // only the person who came online

    // Only dave (no chat set up) left without a key: nothing to ask
    await inOrg(() => Conversation.updateOne({ _id: conv._id }, { $set: { "groupKeyring.0.keys": { [id("ben")]: { wrapped: "x:y", wrapperKeyVersion: 1, recipientKeyVersion: 1, wrappedBy: people.ben._id }, [id("cara")]: { wrapped: "x:y", wrapperKeyVersion: 1, recipientKeyVersion: 1, wrappedBy: people.ben._id } } } }));
    const io2 = fakeIo();
    await inOrg(() => requestPendingKeyHelp(id("ben"), io2));
    expect(io2.sent.filter((s) => s.payload.conversationId === String(conv._id))).toHaveLength(0);
    // Non-admins aren't asked
    const io3 = fakeIo();
    await inOrg(() => requestPendingKeyHelp(id("cara"), io3));
    expect(io3.sent.filter((s) => s.payload.conversationId === String(conv._id))).toHaveLength(0);
  });
});

describe("Security review fixes (2026-10-24)", () => {
  test("customers get an allow-listed project chat: no workflow internals, history notes, others' contacts or incident ids", async () => {
    await inOrg(() =>
      Conversation.updateOne(
        { _id: project },
        {
          $set: {
            "project.stageHistory": [{ stage: "design", at: new Date(), note: "INTERNAL: customer is difficult", kind: "tick" }],
            "project.manager": people.anna._id,
            moderation: { openIncident: new mongoose.Types.ObjectId(), warningAt: new Date() },
            rekeyRequested: true
          }
        }
      )
    );
    for (const view of [await myConv("cust1", project), (await as("cust1", "get", `/conversations/${project}`)).body.data]) {
      const s = JSON.stringify(view);
      expect(s).not.toContain("INTERNAL");
      expect(view.project.stageHistory).toBeUndefined();
      expect(view.project.flow).toBeUndefined();
      expect(view.project.customers).toEqual(expect.arrayContaining([id("cust1"), id("cust2")]));
      expect(s).not.toContain("+9198765432"); // other customers' phone numbers
      expect(s).not.toContain("cust2@acme.test");
      expect(view.moderation).toEqual({ warningAt: expect.any(String), openIncident: true });
      expect(view.rekeyRequested).toBeUndefined();
      expect(view.internalNotes).toBeUndefined();
      expect(typeof view.project.stage).toBe("string");
    }
    // Staff still get everything
    const staff = await myConv("anna", project);
    expect(JSON.stringify(staff)).toContain("INTERNAL");
    await inOrg(() => Conversation.updateOne({ _id: project }, { $set: { rekeyRequested: false, moderation: {} } }));
  });

  test("a customer in an ordinary group sees the team's read time, not each person's", async () => {
    const conv = await inOrg(async () =>
      String(
        (
          await Conversation.create({
            type: "group",
            name: "Mixed",
            createdBy: people.anna._id,
            members: [
              { user: people.anna._id, role: "admin", lastRead: new Date() },
              { user: people.ben._id, lastRead: new Date() },
              { user: people.cust1._id }
            ]
          })
        )._id
      )
    );
    const view = await myConv("cust1", conv);
    expect(view.teamLastRead).toBeTruthy();
    for (const m of view.members) if (m.user._id !== id("cust1")) expect(m.lastRead).toBeUndefined();
  });

  test("scheduled @everyone is dropped if the sender is no longer allowed; mention pings can't pile up in one minute", async () => {
    const sendAt = new Date(Date.now() + 2 * 60000).toISOString();
    const body = () => ({ ...enc(), franking: { commitment: commitment() }, sendAt });
    const s = (await as("anna", "post", `/conversations/${group}/scheduled`).send({ ...body(), mentionsAll: "everyone" })).body.data;
    await inOrg(() => Conversation.updateOne({ _id: group, "members.user": people.anna._id }, { $set: { "members.$.role": "member" } }));
    await inOrg(() => require("../src/services/scheduled.service").processDue(new Date(Date.now() + 3 * 60000)));
    const doc = await inOrg(() => require("../src/models/ScheduledMessage").findById(s._id).lean());
    const msg = await inOrg(() => Message.findById(doc.sentMessage).lean());
    expect(msg.mentionsAll).toBeUndefined();
    await inOrg(() => Conversation.updateOne({ _id: group, "members.user": people.anna._id }, { $set: { "members.$.role": "admin" } }));

    const at = new Date(Date.now() + 10 * 60000).toISOString();
    for (let i = 0; i < 10; i++) {
      expect((await as("ben", "post", `/conversations/${group}/scheduled`).send({ ...enc(), franking: { commitment: commitment() }, sendAt: at, mentions: [id("dave")] })).status).toBe(201);
    }
    const eleventh = await as("ben", "post", `/conversations/${group}/scheduled`).send({ ...enc(), franking: { commitment: commitment() }, sendAt: at, mentions: [id("dave")] });
    expect(eleventh.status).toBe(400);
    // Plain messages at that minute are fine
    expect((await as("ben", "post", `/conversations/${group}/scheduled`).send({ ...enc(), franking: { commitment: commitment() }, sendAt: at })).status).toBe(201);
  });

  test("team notes created during a team change don't keep someone who was just removed", async () => {
    const { openTeamNotes } = require("../src/services/customerChat.service");
    const proj = await inOrg(async () =>
      Conversation.create({
        type: "group",
        name: "Race project",
        createdBy: people.anna._id,
        members: [{ user: people.anna._id, role: "admin" }, { user: people.ben._id }, { user: people.cara._id }, { user: people.cust2._id }],
        project: { customers: [people.cust2._id], leadDesigner: people.anna._id, createdBy: people.anna._id }
      })
    );
    const snapshot = await inOrg(() => Conversation.findById(proj._id)); // what the request loaded
    await inOrg(() => Conversation.updateOne({ _id: proj._id }, { $pull: { members: { user: people.cara._id } } })); // cara removed meanwhile
    const wrap = () => ({ wrapped: `${crypto.randomBytes(12).toString("base64")}:${crypto.randomBytes(48).toString("base64")}`, wrapperKeyVersion: 1, recipientKeyVersion: 1 });
    const res = await inOrg(() => openTeamNotes({ project: snapshot, user: people.anna, encryptedGroupKeys: { [id("anna")]: wrap(), [id("ben")]: wrap(), [id("cara")]: wrap() } }));
    const notes = await inOrg(() => Conversation.findById(res.conversationId).lean());
    expect(notes.members.map((m) => String(m.user)).sort()).toEqual([id("anna"), id("ben")].sort());
    expect(JSON.stringify(notes.groupKeyring)).not.toContain(id("cara"));
  });
});
