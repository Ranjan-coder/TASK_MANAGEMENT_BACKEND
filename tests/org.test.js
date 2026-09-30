process.env.NODE_ENV = "test";

const { orgKey } = require("../src/utils/orgKey");
const perms = require("../src/config/permissions");
const { DEPARTMENTS, DESIGNATIONS } = require("../src/config/orgSeed");
const { STAFF_ROLES } = require("../src/config/roles");
const v = require("../src/validators/org.validator");
const { graphFrom, rootsOf, teamOf, chainReaches } = require("../src/services/org.service")._internals;

describe("orgKey (duplicate-name protection)", () => {
  test("case, spacing and punctuation don't make a new name", () => {
    expect(orgKey("TECH")).toBe(orgKey(" tech "));
    expect(orgKey("Pre-Sales")).toBe(orgKey("Pre Sales"));
    expect(orgKey("Finance & Accounts")).toBe(orgKey("finance and accounts"));
  });
  test("different names stay different", () => {
    expect(orgKey("Marketing")).not.toBe(orgKey("Digital Marketing"));
    expect(orgKey("IT")).not.toBe(orgKey("Tech"));
  });
  test("a name with no letters or numbers has an empty key", () => {
    expect(orgKey("--- ")).toBe("");
  });
});

describe("seed lists", () => {
  test("department names are unique by key", () => {
    expect(new Set(DEPARTMENTS.map(orgKey)).size).toBe(DEPARTMENTS.length);
  });
  test("designations are unique, levelled 1–9, with valid roles and departments", () => {
    const deptKeys = new Set(DEPARTMENTS.map(orgKey));
    expect(new Set(DESIGNATIONS.map(([n]) => orgKey(n))).size).toBe(DESIGNATIONS.length);
    for (const [name, , level, role, depts] of DESIGNATIONS) {
      expect(level).toBeGreaterThanOrEqual(1);
      expect(level).toBeLessThanOrEqual(9);
      expect(STAFF_ROLES).toContain(role);
      for (const d of depts) expect(deptKeys.has(orgKey(d))).toBe(true);
      expect(name.length).toBeGreaterThan(1);
    }
  });
  test("includes the titles asked for (BM, GM, DGM, GTM, CEO, Chairman, MD, CMO, Marketing Executive)", () => {
    const shorts = new Set(DESIGNATIONS.map(([, s]) => s));
    for (const s of ["BM", "GM", "DGM", "GTM", "CEO", "MD", "CMO"]) expect(shorts.has(s)).toBe(true);
    const names = new Set(DESIGNATIONS.map(([n]) => n));
    for (const n of ["Chairman", "Marketing Executive", "Branch Manager", "Go-To-Market Manager"]) expect(names.has(n)).toBe(true);
    expect(DEPARTMENTS).toContain("Designer");
  });
  test("only leadership titles suggest the leadership role, and none suggests superadmin", () => {
    for (const [, , level, role] of DESIGNATIONS) {
      if (role === "leadership") expect(level).toBe(1);
      expect(role).not.toBe("superadmin");
    }
  });
});

describe("permissions (bitmask)", () => {
  test("admins and superadmins hold everything; customers nothing, even if granted", () => {
    expect(perms.effectivePermissions({ role: "admin" })).toEqual(perms.PERMISSION_KEYS);
    expect(perms.effectivePermissions({ role: "superadmin" })).toEqual(perms.PERMISSION_KEYS);
    expect(perms.effectivePermissions({ role: "customer", permissions: ["payments.confirm"] })).toEqual([]);
  });
  test("leadership gets the read-only set without a grant", () => {
    const eff = perms.effectivePermissions({ role: "leadership", permissions: [] });
    expect(eff.sort()).toEqual(["leads.view", "payments.view", "performance.view", "projects.view"].sort());
    expect(perms.hasPermission({ role: "leadership" }, "payments.confirm")).toBe(false);
  });
  test("a grant adds exactly that permission", () => {
    const u = { role: "user", permissions: ["payments.confirm"] };
    expect(perms.hasPermission(u, "payments.confirm")).toBe(true);
    expect(perms.hasPermission(u, "leads.view")).toBe(false);
  });
  test("unknown permission names are ignored", () => {
    expect(perms.hasPermission({ role: "user", permissions: ["everything"] }, "everything")).toBe(false);
    expect(perms.permissionMask({ role: "user", permissions: ["nope"] })).toBe(0);
  });
});

describe("org validators", () => {
  const ok = (name) => v.createDepartmentSchema.safeParse({ body: { name } }).success;
  test("accepts real department names", () => {
    for (const n of ["Finance & Accounts", "3D Visualisation", "Pre-Sales", "Admin & Facilities", "R&D (Labs)"]) expect(ok(n)).toBe(true);
  });
  test("refuses markup, control characters and one-letter names", () => {
    for (const n of ["<script>x</script>", "Tech\u0000", "A", " & Tech", "a".repeat(61)]) expect(ok(n)).toBe(false);
  });
  test("refuses unknown fields and bad levels", () => {
    expect(v.createDepartmentSchema.safeParse({ body: { name: "Ops", key: "x" } }).success).toBe(false);
    expect(v.createDesignationSchema.safeParse({ body: { name: "Boss", level: 0 } }).success).toBe(false);
    expect(v.createDesignationSchema.safeParse({ body: { name: "Boss", level: 10 } }).success).toBe(false);
    expect(v.createDesignationSchema.safeParse({ body: { name: "Boss", level: 4, suggestedRole: "customer" } }).success).toBe(false);
  });
  test("permission lists must be known and unique", () => {
    const p = (permissions) => v.permissionsSchema.safeParse({ params: { id: "64b7f0c2a1b2c3d4e5f60718" }, body: { permissions } }).success;
    expect(p(["leads.view", "payments.confirm"])).toBe(true);
    expect(p([])).toBe(true);
    expect(p(["leads.view", "leads.view"])).toBe(false);
    expect(p(["superpowers"])).toBe(false);
  });
});

describe("org chart and team (graph algorithms)", () => {
  const person = (id, name, reportsTo = null, level = 99) => ({ _id: id, name, reportsTo, level });
  const levelOf = (u) => u.level;
  //        ceo
  //       /    \
  //     gm      cfo
  //    /  \
  //  bm1   bm2
  //   |
  //  exec
  const people = [
    person("ceo", "Asha", null, 1),
    person("cfo", "Farah", "ceo", 2),
    person("gm", "Gita", "ceo", 4),
    person("bm2", "Zoya", "gm", 5),
    person("bm1", "Bala", "gm", 5),
    person("exec", "Esha", "bm1", 8)
  ];

  test("builds one tree, children sorted by level then name", () => {
    const nodes = graphFrom(people, levelOf);
    const roots = rootsOf(nodes);
    expect(roots.map((n) => n._id)).toEqual(["ceo"]);
    expect(roots[0].reports.map((n) => n._id)).toEqual(["cfo", "gm"]);
    expect(nodes.get("gm").reports.map((n) => n._id)).toEqual(["bm1", "bm2"]);
  });

  test("team is breadth-first with depth", () => {
    const team = teamOf(graphFrom(people, levelOf), "gm");
    expect(team.direct.map((n) => n._id)).toEqual(["bm1", "bm2"]);
    expect(team.all.map((n) => [n._id, n.depth])).toEqual([["bm1", 1], ["bm2", 1], ["exec", 2]]);
    expect(team.all.find((n) => n._id === "bm1").reportCount).toBe(1);
  });

  test("someone whose manager left shows at the top instead of disappearing", () => {
    const roots = rootsOf(graphFrom([...people, person("x", "Ravi", "gone", 8)], levelOf));
    expect(roots.map((n) => n._id).sort()).toEqual(["ceo", "x"]);
  });

  test("a reporting loop in bad data doesn't hang and still shows everyone", () => {
    const loop = [person("a", "A", "b"), person("b", "B", "c"), person("c", "C", "a")];
    const nodes = graphFrom(loop, levelOf);
    const roots = rootsOf(nodes);
    expect(roots.length).toBe(1); // one entry point per loop
    expect(teamOf(nodes, "a").all.map((n) => n._id).sort()).toEqual(["b", "c"]);
  });

  test("cycle check walks up the chain", () => {
    const up = new Map(people.filter((p) => p.reportsTo).map((p) => [p._id, p.reportsTo]));
    // Making the GM report to the exec (who is under the GM) would loop
    expect(chainReaches(up, "exec", "gm")).toBe(true);
    // The exec reporting to the CFO is fine
    expect(chainReaches(up, "cfo", "exec")).toBe(false);
    // A loop already in the data stops at the hop limit instead of spinning
    expect(chainReaches(new Map([["a", "b"], ["b", "a"]]), "a", "z")).toBe(false);
  });
});
