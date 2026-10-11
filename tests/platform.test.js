/**
 * Phase 2 (module-access-plan.md): the module catalog's graph rules, organisation
 * entitlements, and the product owner's console against a real (in-memory) MongoDB.
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";

const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");

const modules = require("../src/config/modules");
const { buildRegistry } = modules;
const tenant = require("../src/utils/tenantContext");
const Organisation = require("../src/models/Organisation");
const User = require("../src/models/User");
const Task = require("../src/models/Task");
const { computeEntitlements, invalidate } = require("../src/services/organisation.service");
const { newSalt, deriveAuthKey } = require("../src/utils/kdf");

jest.setTimeout(120000);

describe("module registry", () => {
  const mod = (key, bit, requires = []) => ({ key, bit, label: key, description: "", requires });

  test("a dependency cycle stops the server from starting", () => {
    expect(() => buildRegistry([mod("a", 0, ["b"]), mod("b", 1, ["c"]), mod("c", 2, ["a"])])).toThrow(/cycle/);
  });

  test("bad catalogs are refused", () => {
    expect(() => buildRegistry([mod("a", 0, ["missing"])])).toThrow(/unknown module/);
    expect(() => buildRegistry([mod("a", 0), mod("b", 0)])).toThrow(/reuses bit/);
    expect(() => buildRegistry([mod("a", 0), mod("a", 1)])).toThrow(/Duplicate/);
    expect(() => buildRegistry([mod("a", 31)])).toThrow(/invalid bit/);
  });

  test("closures are transitive in both directions", () => {
    expect(modules.fromMask(modules.REQUIRES_MASK.referrals).sort()).toEqual(["customer_portal", "projects"]);
    expect(modules.fromMask(modules.REQUIRES_MASK.moderation).sort()).toEqual(["chat", "projects"]);
    expect(modules.fromMask(modules.DEPENDENTS_MASK.projects).sort()).toEqual(
      ["chat", "customer_portal", "moderation", "payments", "referrals", "reports"].sort()
    );
    expect(modules.DEPENDENTS_MASK.tasks).toBe(0);
  });

  test("a module whose requirement is off doesn't count; core is always on", () => {
    const mask = modules.effectiveMask(modules.toMask(["chat", "tasks"])); // chat without projects
    expect(modules.fromMask(mask).sort()).toEqual(["core", "organisation", "privacy", "tasks"].sort());
    const full = modules.effectiveMask(modules.toMask(["chat", "projects"]));
    expect(mask & modules.BIT.chat).toBe(0);
    expect(full & modules.BIT.chat).not.toBe(0);
  });

  test("bits are explicit and stable (append-only)", () => {
    // Changing any of these would silently change what stored masks mean
    expect(modules.BIT.tasks).toBe(1 << 3);
    expect(modules.BIT.moderation).toBe(1 << 13);
    expect(modules.BIT.branding).toBe(1 << 15);
  });

  test("organisation-wide modules (branding) are held by everyone and never take seats", () => {
    const { GRANTABLE_MASK, userModuleMask } = require("../src/services/moduleAccess.service");
    expect(modules.ORG_WIDE_MASK).toBe(modules.BIT.branding);
    expect(GRANTABLE_MASK & modules.BIT.branding).toBe(0);
    expect(userModuleMask({ role: "user", moduleAccess: { keys: [] } }) & modules.BIT.branding).not.toBe(0);
    expect(userModuleMask({ role: "customer" }) & modules.BIT.branding).not.toBe(0);
    expect(() => buildRegistry([{ ...mod("a", 0), orgWide: true, defaultOn: true }])).toThrow(/orgWide/);
  });
});

describe("entitlements", () => {
  const org = (mods, status = "active") => ({ status, entitlementVersion: 1, modules: mods });

  test("expiry is applied when read, and remembered until the next expiry", () => {
    const soon = new Date(Date.now() + 60_000);
    const e = computeEntitlements(org([{ key: "tasks", enabled: true, expiresAt: soon }, { key: "leads", enabled: true }]));
    expect(e.mask & modules.BIT.tasks).not.toBe(0);
    expect(e.validUntil).toBe(soon.getTime());
    const later = computeEntitlements(org([{ key: "tasks", enabled: true, expiresAt: soon }]), soon.getTime() + 1);
    expect(later.mask & modules.BIT.tasks).toBe(0);
  });

  test("a suspended organisation has nothing", () => {
    expect(computeEntitlements(org([{ key: "tasks", enabled: true }], "suspended")).mask).toBe(0);
  });
});

describe("product owner console (HTTP)", () => {
  let mongod;
  let app;
  let ownerCookie;
  let alpha;
  const PASSWORD = "Sample-Pass1";

  const makeUser = (fields, orgId) => {
    const run = orgId ? (fn) => tenant.runInOrg(orgId, fn) : tenant.runAsPlatform;
    return run(async () => {
      const salt = newSalt();
      const u = new User({ name: "Person", ...fields });
      u.setDerivedCredential(deriveAuthKey(PASSWORD, salt), salt);
      return u.save();
    });
  };
  // Every sign-in names its organisation (D-R1); here it follows the email's domain
  const login = async (identifier, organisation, password = PASSWORD) => {
    organisation = organisation || (identifier.endsWith("@platform.test") ? "platform" : identifier.split("@")[1].split(".")[0]);
    const pre = await request(app).post("/api/v1/auth/prelogin").send({ identifier, ...(organisation && { organisation }) });
    const authKey = deriveAuthKey(password, pre.body.data.kdf.salt);
    return request(app).post("/api/v1/auth/login").send({ identifier, authKey, ...(organisation && { organisation }) });
  };
  const cookiesOf = (res) => res.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
  const asOwner = (method, url) => request(app)[method](`/api/v1/platform${url}`).set("Cookie", ownerCookie);

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { autoIndex: true });
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
    app = require("../src/app");

    alpha = await Organisation.create({ name: "Alpha Interiors", slug: "alpha", modules: [{ key: "tasks", enabled: true }] });
    await makeUser({ email: "boss@alpha.test", role: "superadmin" }, alpha._id);
    await makeUser({ email: "cust@alpha.test", role: "customer" }, alpha._id);
    await tenant.runInOrg(alpha._id, async () => {
      const boss = await User.findOne({ email: "boss@alpha.test" });
      await Task.create({ title: "Secret alpha task", assignedBy: boss._id, assignedTo: [boss._id], dueDate: new Date(Date.now() + 3600e3) });
    });
    await makeUser({ email: "owner@platform.test", role: "platform_owner" });

    const res = await login("owner@platform.test");
    expect(res.status).toBe(200);
    ownerCookie = cookiesOf(res);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod?.stop();
  });

  test("the product owner has no organisation and sees no organisation data", async () => {
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", ownerCookie);
    expect(me.body.data.organisation).toBeNull();
    expect((await request(app).get("/api/v1/users").set("Cookie", ownerCookie)).status).toBe(403);
    expect((await request(app).get("/api/v1/tasks").set("Cookie", ownerCookie)).status).toBe(403);
    // Even a direct query in their scope finds nothing of an organisation's
    expect(await tenant.runAsPlatform(() => Task.find())).toEqual([]);
  });

  test("organisation list: modules and usage counts, never people", async () => {
    const res = await asOwner("get", "/organisations");
    expect(res.status).toBe(200);
    const row = res.body.data.find((o) => o.slug === "alpha");
    expect(row.usage).toMatchObject({ staff: 1, customers: 1 });
    expect(row.modules.find((m) => m.key === "tasks")).toMatchObject({ enabled: true, effective: true });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("boss@alpha.test");
    expect(body).not.toContain("Secret alpha task");
  });

  test("an organisation superadmin can't open the console", async () => {
    const boss = await login("boss@alpha.test");
    const res = await request(app).get("/api/v1/platform/organisations").set("Cookie", cookiesOf(boss));
    expect(res.status).toBe(403);
  });

  test("creating an organisation creates its first superadmin, who must change the password", async () => {
    const salt = newSalt();
    const res = await asOwner("post", "/organisations").send({
      name: "Beta Homes",
      slug: "beta",
      modules: ["referrals"],
      superadmin: { name: "Beta Boss", email: "boss@beta.test", authKey: deriveAuthKey("Initial-Pass9", salt), kdfSalt: salt }
    });
    expect(res.status).toBe(201);
    // referrals pulled in what it needs
    const on = res.body.data.modules.filter((m) => m.enabled && !m.core && !m.defaultOn).map((m) => m.key).sort();
    expect(on).toEqual(["customer_portal", "projects", "referrals"]);
    // On-by-default modules are on without being chosen
    expect(res.body.data.modules.find((m) => m.key === "planner")).toMatchObject({ enabled: true, effective: true });

    const signIn = await login("boss@beta.test", undefined, "Initial-Pass9");
    expect(signIn.status).toBe(200);
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookiesOf(signIn));
    expect(me.body.data).toMatchObject({ role: "superadmin", mustChangePassword: true });
    expect(me.body.data.organisation.slug).toBe("beta");
    expect(me.body.data.organisation.modules).toEqual(expect.arrayContaining(["referrals", "projects", "core"]));

    const dup = await asOwner("post", "/organisations").send({
      name: "Again",
      slug: "beta",
      superadmin: { name: "X Y", email: "x@y.test", authKey: deriveAuthKey("Initial-Pass9", salt), kdfSalt: salt }
    });
    expect(dup.status).toBe(409);
  });

  test("switching a module on pulls in its requirements; switching off a needed one is refused", async () => {
    const on = await asOwner("put", `/organisations/${alpha._id}/modules/moderation`).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.data.pulledIn.sort()).toEqual(["chat", "projects"]);

    const off = await asOwner("put", `/organisations/${alpha._id}/modules/projects`).send({ enabled: false });
    expect(off.status).toBe(409);
    expect(off.body.errors[0].code).toBe("MODULE_NEEDED");
    expect(off.body.errors[0].modules.sort()).toEqual(["chat", "moderation"]);

    // Leaves first, then the dependency
    for (const key of ["moderation", "chat", "projects"]) {
      expect((await asOwner("put", `/organisations/${alpha._id}/modules/${key}`).send({ enabled: false })).status).toBe(200);
    }
  });

  test("end dates must be in the future; seat limits are bounded; core can't be switched", async () => {
    expect((await asOwner("put", `/organisations/${alpha._id}/modules/tasks`).send({ expiresAt: "2001-01-01" })).status).toBe(400);
    expect((await asOwner("put", `/organisations/${alpha._id}/modules/tasks`).send({ seatLimit: 0 })).status).toBe(400);
    expect((await asOwner("put", `/organisations/${alpha._id}/modules/core`).send({ enabled: false })).status).toBe(400);
    const ok = await asOwner("put", `/organisations/${alpha._id}/modules/tasks`).send({ seatLimit: 5, expiresAt: new Date(Date.now() + 86400e3).toISOString() });
    expect(ok.status).toBe(200);
    expect(ok.body.data.organisation.modules.find((m) => m.key === "tasks")).toMatchObject({ seatLimit: 5, effective: true });
  });

  test("a stale version is refused instead of overwriting another change", async () => {
    const platform = require("../src/services/platform.service");
    const realUpdate = Organisation.updateOne.bind(Organisation);
    // Someone else changes the organisation between our read and our write
    const spy = jest.spyOn(Organisation, "updateOne").mockImplementationOnce(async (filter, update, opts) => {
      await realUpdate({ _id: alpha._id }, { $inc: { entitlementVersion: 1 } });
      return realUpdate(filter, update, opts);
    });
    await expect(
      tenant.runAsPlatform(() => platform.setModule(alpha._id, "leads", { enabled: true }, { user: { _id: new mongoose.Types.ObjectId() }, headers: {} }))
    ).rejects.toMatchObject({ statusCode: 409 });
    spy.mockRestore();
  });

  test("suspending an organisation locks its people out; reactivating lets them back", async () => {
    const boss = cookiesOf(await login("boss@alpha.test"));
    expect((await asOwner("patch", `/organisations/${alpha._id}`).send({ status: "suspended" })).status).toBe(200);
    expect((await request(app).get("/api/v1/auth/me").set("Cookie", boss)).status).toBe(403);
    expect((await asOwner("patch", `/organisations/${alpha._id}`).send({ status: "active" })).status).toBe(200);
    invalidate(alpha._id);
    expect((await request(app).get("/api/v1/auth/me").set("Cookie", boss)).status).toBe(200);
  });

  test("every console change is in the product owner's audit trail", async () => {
    const res = await asOwner("get", "/audit");
    const actions = res.body.data.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["platform_org_created", "platform_module_changed", "platform_org_suspended", "platform_org_active"]));
    // Organisations' own audit logs never include these
    const orgLogs = await tenant.runInOrg(alpha._id, () => require("../src/models/AuditLog").find({ action: /^platform_/ }));
    expect(orgLogs).toEqual([]);
  });

  // ── Phase 3: enforcement ──────────────────────────────────────────────────
  test("switching a module off blocks its routes at once; switching it on restores them", async () => {
    const boss = cookiesOf(await login("boss@alpha.test"));
    await asOwner("put", `/organisations/${alpha._id}/modules/tasks`).send({ enabled: true });
    expect((await request(app).get("/api/v1/tasks").set("Cookie", boss)).status).toBe(200);

    await asOwner("put", `/organisations/${alpha._id}/modules/tasks`).send({ enabled: false });
    const off = await request(app).get("/api/v1/tasks").set("Cookie", boss);
    expect(off.status).toBe(403);
    expect(off.body.errors[0]).toMatchObject({ code: "MODULE_DISABLED", module: "tasks" });
    // Core keeps working
    expect((await request(app).get("/api/v1/users").set("Cookie", boss)).status).toBe(200);
    // The app is told which modules exist
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", boss);
    expect(me.body.data.organisation.modules).not.toContain("tasks");

    await asOwner("put", `/organisations/${alpha._id}/modules/tasks`).send({ enabled: true });
    expect((await request(app).get("/api/v1/tasks").set("Cookie", boss)).status).toBe(200);
  });

  test("a module whose requirement is off is blocked too", async () => {
    const boss = cookiesOf(await login("boss@alpha.test"));
    await asOwner("put", `/organisations/${alpha._id}/modules/chat`).send({ enabled: true }); // pulls in projects
    expect((await request(app).get("/api/v1/chat/conversations").set("Cookie", boss)).status).toBe(200);
    // A lapsed requirement (e.g. Projects ended), written straight to the database
    await Organisation.updateOne({ _id: alpha._id, "modules.key": "projects" }, { $set: { "modules.$.enabled": false } });
    invalidate(alpha._id);
    const res = await request(app).get("/api/v1/chat/conversations").set("Cookie", boss);
    expect(res.status).toBe(403);
    expect(res.body.errors[0].module).toBe("chat");
  });

  test("customers can't sign in without the customer portal", async () => {
    const res = await login("cust@alpha.test");
    expect(res.status).toBe(403);
    expect(res.body.errors[0]).toMatchObject({ code: "MODULE_DISABLED", module: "customer_portal" });
  });

  test("a new product owner can change the forced first password, then use the console", async () => {
    await makeUser({ email: "fresh@platform.test", role: "platform_owner", mustChangePassword: true });
    const signIn = await login("fresh@platform.test");
    expect(signIn.status).toBe(200);
    const cookie = cookiesOf(signIn);
    // Before the change: only sign-in routes (and reading the key backup) work
    expect((await request(app).get("/api/v1/platform/organisations").set("Cookie", cookie)).body.errors[0].code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await request(app).get("/api/v1/chat/keys/bundle").set("Cookie", cookie)).status).toBe(200);
    // What the Settings screen sends: keys derived from the old and the new password
    const kdf = (await request(app).get("/api/v1/auth/kdf").set("Cookie", cookie)).body.data.kdf;
    const newSalt2 = newSalt();
    const changed = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Cookie", cookie)
      .send({ currentAuthKey: deriveAuthKey(PASSWORD, kdf.salt), newAuthKey: deriveAuthKey("Brand-New-Pass7", newSalt2), newKdfSalt: newSalt2 });
    expect(changed.status).toBe(200);
    expect(changed.body.data.user.mustChangePassword).toBe(false);
    const fresh = changed.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
    expect((await request(app).get("/api/v1/platform/organisations").set("Cookie", fresh)).status).toBe(200);
  });

  // ── Branding: the organisation's own name instead of the product name ──────
  test("the display name shows only while the branding module is on", async () => {
    const bossLogin = await login("boss@alpha.test");
    expect(bossLogin.body).toMatchObject({ success: true });
    const boss = cookiesOf(bossLogin);
    const brand = async () => (await request(app).get("/api/v1/auth/me").set("Cookie", boss)).body.data.organisation.brandName;

    expect(await brand()).toBeNull(); // nothing set: the app shows the product name
    const named = await asOwner("patch", `/organisations/${alpha._id}`).send({ displayName: "Alpha Homes" });
    expect(named.status).toBe(200);
    expect(named.body.data.displayName).toBe("Alpha Homes");
    expect(await brand()).toBeNull(); // the module is off

    const on = await asOwner("put", `/organisations/${alpha._id}/modules/branding`).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(await brand()).toBe("Alpha Homes");
    // Push titles and the authenticator entry use it too (inside the organisation)
    const { currentBrandName } = require("../src/services/organisation.service");
    expect(await tenant.runInOrg(alpha._id, () => currentBrandName())).toBe("Alpha Homes");
    expect(await tenant.runAsPlatform(() => currentBrandName())).toBe("Serenx");

    // Clearing the name falls back to the product name
    expect((await asOwner("patch", `/organisations/${alpha._id}`).send({ displayName: "" })).body.data.displayName).toBeNull();
    expect(await brand()).toBeNull();

    await asOwner("put", `/organisations/${alpha._id}/modules/branding`).send({ enabled: false });
  });

  test("display names are plain text, and branding has no seats", async () => {
    for (const bad of ["<script>x</script>", "A", "x".repeat(61), "Tab\tname"]) {
      expect((await asOwner("patch", `/organisations/${alpha._id}`).send({ displayName: bad })).status).toBe(400);
    }
    // Branding has no seats
    expect((await asOwner("put", `/organisations/${alpha._id}/modules/branding`).send({ seatLimit: 5 })).status).toBe(400);
    // (An organisation's superadmin can't reach the console at all: see the test above.)
  });
});
