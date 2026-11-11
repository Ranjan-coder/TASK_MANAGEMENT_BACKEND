/**
 * Accounts deleted outside the app (e.g. straight from the database) must not
 * break chats: populate() returns null for them, which crashed the Chat page.
 */
process.env.NODE_ENV = "test";
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const Conversation = require("../src/models/Conversation");
const Message = require("../src/models/Message");
const chat = require("../src/services/chat.service");
const { withoutMissingPeople, withSender } = require("../src/utils/presentPeople");

jest.setTimeout(120000);
let mongod;
let org;
const inOrg = (fn) => tenant.runInOrg(org._id, fn);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  org = await Organisation.create({ name: "Delta", slug: "delta" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

test("helpers drop missing people and label missing senders", () => {
  const conv = { members: [{ user: { _id: "a" } }, { user: null }], project: { customers: [null, { _id: "c" }] } };
  expect(withoutMissingPeople(conv).members).toHaveLength(1);
  expect(withoutMissingPeople(conv).project.customers).toHaveLength(1);
  expect(withSender({ sender: null }).sender.name).toBe("Deleted user");
  expect(withSender({ sender: { name: "Asha" } }).sender.name).toBe("Asha");
});

test("a chat with a deleted member still lists, without that member; their messages show as Deleted user", async () => {
  const [me, gone] = await inOrg(() =>
    User.create([
      { name: "Me", email: "me@delta.com", role: "user", password: "x".repeat(60) },
      { name: "Gone", email: "gone@delta.com", role: "user", password: "x".repeat(60) }
    ])
  );
  const conv = await inOrg(() =>
    Conversation.create({ type: "dm", createdBy: me._id, members: [{ user: me._id, role: "member" }, { user: gone._id, role: "member" }] })
  );
  await inOrg(() => Message.create({ conversation: conv._id, sender: gone._id, type: "text", ciphertext: "x".repeat(24), iv: "y".repeat(16) }));
  await User.collection.deleteOne({ _id: gone._id }); // deleted straight from the database

  const list = await inOrg(() => chat.getUserConversations(me._id));
  expect(list).toHaveLength(1);
  expect(list[0].members.map((m) => m.user.name)).toEqual(["Me"]);

  const page = await inOrg(() => chat.getMessages({ conversationId: conv._id, userId: me._id, limit: 30 }));
  const items = page.messages || page.items;
  expect(items[0].sender).toMatchObject({ _id: null, name: "Deleted user" });
});
