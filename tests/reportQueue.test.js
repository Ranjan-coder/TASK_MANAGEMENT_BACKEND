/**
 * Admin report queue against a real (in-memory) MongoDB: the tab counts must
 * describe the same reports the list shows. Regression: a tab said "1" over
 * an empty list because the admin had filed that report themselves (it's
 * hidden from them) while the counts ignored that.
 */
process.env.NODE_ENV = "test";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const Report = require("../src/models/Report");
const { listForAdmin } = require("../src/services/report.service");

jest.setTimeout(120000);

let mongod;
let org;
let other;
const oid = () => new mongoose.Types.ObjectId();
const admin = { _id: oid() };
const otherAdmin = { _id: oid() };
const customer = oid();
const designer = oid();
let ticket = 1000;

const file = (o, fields) =>
  tenant.runInOrg(o._id, () =>
    Report.create({
      ticketNo: ++ticket,
      conversation: oid(),
      description: "Something happened in the project chat today.",
      ...fields
    })
  );

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
  await Report.init();
  org = await Organisation.create({ name: "Acme", slug: "acme" });
  other = await Organisation.create({ name: "Other", slug: "other" });

  // The admin flagged a customer; someone else closed it (the reported case)
  await file(org, { reporter: admin._id, reportedUser: customer, direction: "staff_to_customer", reason: "abusive_language", status: "action_taken" });
  // A customer reported the admin
  await file(org, { reporter: customer, reportedUser: admin._id, direction: "customer_to_staff", reason: "rude", status: "submitted" });
  // Two the admin should review
  await file(org, { reporter: customer, reportedUser: designer, direction: "customer_to_staff", reason: "slow_responses", status: "submitted" });
  await file(org, { reporter: designer, reportedUser: customer, direction: "staff_to_customer", reason: "threats", status: "action_taken" });
  // Another organisation's report: never counted here
  await file(other, { reporter: customer, reportedUser: designer, direction: "customer_to_staff", reason: "rude", status: "action_taken" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const list = (opts) => tenant.runInOrg(org._id, () => listForAdmin(opts));

test("every tab count matches what that tab lists; reports involving the viewer are explained, not silently counted", async () => {
  for (const status of [undefined, "submitted", "under_review", "action_taken", "dismissed"]) {
    const page = await list({ viewer: admin, status });
    // Counts per status, from the "all" view, must equal each tab's real list length
    const all = await list({ viewer: admin });
    expect(page.items.length).toBe(status ? all.counts[status] || 0 : Object.values(all.counts).reduce((a, b) => a + b, 0));
    // The two reports involving the admin (abusive_language: they filed it; rude: it's about them) never appear
    expect(page.items.some((r) => ["abusive_language", "rude"].includes(r.reason))).toBe(false);
  }
  const done = await list({ viewer: admin, status: "action_taken" });
  expect(done.items.map((r) => r.reason)).toEqual(["threats"]);
  expect(done.counts).toEqual({ submitted: 1, action_taken: 1 });
  expect(done.involvedHidden).toBe(1); // the flag the admin filed
  expect((await list({ viewer: admin })).involvedHidden).toBe(2); // + the report about them
});

test("the direction filter applies to the counts too; another admin sees everything; other organisations never leak", async () => {
  const staffFlags = await list({ viewer: admin, direction: "staff_to_customer" });
  expect(staffFlags.counts).toEqual({ action_taken: 1 });
  expect(staffFlags.involvedHidden).toBe(1);

  const theirs = await list({ viewer: otherAdmin });
  expect(theirs.items).toHaveLength(4);
  expect(theirs.counts).toEqual({ submitted: 2, action_taken: 2 });
  expect(theirs.involvedHidden).toBe(0);
});
