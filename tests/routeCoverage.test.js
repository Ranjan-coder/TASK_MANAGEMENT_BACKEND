/**
 * Walks the real Express route table and checks the customer allow-list
 * against it, so the policy can't silently drift from the actual routes.
 */
process.env.NODE_ENV = "test";
process.env.ENFORCE_PRIVILEGED_2FA = "false";

const app = require("../src/app");
const { evaluateAccess, ROLE_ALLOW_LISTS, normalisePath } = require("../src/middlewares/accessPolicy");

const MOUNTS = {
  "/api/v1/auth": require("../src/routes/auth.routes"),
  "/api/v1/users": require("../src/routes/user.routes"),
  "/api/v1/tasks": require("../src/routes/task.routes"),
  "/api/v1": require("../src/routes/comment.routes"),
  "/api/v1/uploads": require("../src/routes/upload.routes"),
  "/api/v1/notifications": require("../src/routes/notification.routes"),
  "/api/v1/dashboard": require("../src/routes/dashboard.routes"),
  "/api/v1/chat": require("../src/routes/chat.routes"),
  "/api/v1/campaigns": require("../src/routes/content.routes").campaignRoutes,
  "/api/v1/catalog": require("../src/routes/content.routes").catalogRoutes,
  "/api/v1/admin": require("../src/routes/content.routes").adminContentRoutes,
  "/api/v1/admin/projects": require("../src/routes/project.routes"),
  "/api/v1/admin/sla": require("../src/routes/sla.routes").adminSlaRoutes,
  "/api/v1/admin/settings": require("../src/routes/sla.routes").settingsRoutes,
  "/api/v1/sla": require("../src/routes/sla.routes").slaRoutes,
  "/api/v1/admin/reports": require("../src/routes/report.routes").adminReportRoutes,
  "/api/v1/reports": require("../src/routes/report.routes").reportRoutes,
  "/api/v1/ratings": require("../src/routes/report.routes").ratingRoutes,
  "/api/v1/admin/moderation": require("../src/routes/moderation.routes").adminModerationRoutes,
  "/api/v1/moderation": require("../src/routes/moderation.routes").moderationRoutes,
  "/api/v1/admin/monitoring": require("../src/routes/monitoring.routes"),
  "/api/v1/admin/leads": require("../src/routes/phase8.routes").adminLeadRoutes,
  "/api/v1/admin/testimonials": require("../src/routes/phase8.routes").adminTestimonialRoutes,
  "/api/v1/projects": require("../src/routes/phase8.routes").projectRoutes,
  "/api/v1/quick-replies": require("../src/routes/phase8.routes").quickReplyRoutes,
  "/api/v1/testimonials": require("../src/routes/phase8.routes").testimonialRoutes,
  "/api/v1/admin/privacy": require("../src/routes/phase9.routes").adminPrivacyRoutes,
  "/api/v1/push": require("../src/routes/phase9.routes").pushRoutes,
  "/api/v1/privacy": require("../src/routes/phase9.routes").privacyRoutes,
  "/api/v1/admin/payments": require("../src/routes/phase10.routes").adminPaymentRoutes,
  "/api/v1/admin/referrals": require("../src/routes/phase10.routes").adminReferralRoutes,
  "/api/v1/payments": require("../src/routes/phase10.routes").paymentRoutes,
  "/api/v1/referrals": require("../src/routes/phase10.routes").referralRoutes,
  "/api/v1/customer/auth": require("../src/routes/customerAuth.routes"),
  "/api/v1/org": require("../src/routes/org.routes")
};

const SAMPLE_ID = "64b7f0c2a1b2c3d4e5f60718";
const routes = [];
// Routers mounted a second time on an existing base path
const EXTRA_MOUNTS = [["/api/v1/chat", require("../src/routes/phase8.routes").approvalRoutes]];
for (const [base, router] of [...Object.entries(MOUNTS), ...EXTRA_MOUNTS]) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      const concrete = (base + layer.route.path).replace(/:[A-Za-z]+/g, SAMPLE_ID);
      routes.push({ method: method.toUpperCase(), path: base + layer.route.path, url: concrete });
    }
  }
}

const customer = { role: "customer", isTwoFactorEnabled: false, mustChangePassword: false };
const allowedForCustomer = routes.filter(
  (r) => evaluateAccess({ user: customer, method: r.method, originalUrl: r.url }).allowed
);

test("the app loads and exposes routes", () => {
  expect(app).toBeTruthy();
  expect(routes.length).toBeGreaterThan(30);
});

test("customers reach only auth, notifications, profile, chat, campaigns, catalog, report and rating routes", () => {
  const unexpected = allowedForCustomer.filter(
    (r) =>
      !/^\/api\/v1\/(auth|customer\/auth|notifications|chat|campaigns|catalog|reports|ratings|moderation|projects|testimonials|push|privacy|payments|referrals)(\/|$)/.test(r.path) &&
      !["/api/v1/users/profile", "/api/v1/uploads/avatar"].includes(r.path)
  );
  expect(unexpected).toEqual([]);
});

test("customers cannot reach content management", () => {
  expect(allowedForCustomer.filter((r) => r.path.startsWith("/api/v1/admin"))).toEqual([]);
});

test("customers cannot reach any chat management route", () => {
  const management = allowedForCustomer.filter(
    (r) =>
      (r.method === "POST" && r.path === "/api/v1/chat/conversations") ||
      r.path.includes("/members") ||
      (r.path.includes("/group-keys") && !r.path.endsWith("/group-keys/share")) ||
      (r.method === "PATCH" && r.path === "/api/v1/chat/conversations/:id")
  );
  expect(management).toEqual([]);
});

test("every customer allow-list rule matches at least one real route (no stale rules)", () => {
  const stale = ROLE_ALLOW_LISTS.customer.filter(
    (rule) =>
      !routes.some((r) => {
        const path = normalisePath(r.url);
        return (rule.method === "*" || rule.method === r.method) && rule.regex.test(path);
      })
  );
  expect(stale.map((r) => `${r.method} ${r.regex}`)).toEqual([]);
});

test("customers and marketing can't reach reply-timer or settings routes", () => {
  const marketing = { role: "marketing", isTwoFactorEnabled: false, mustChangePassword: false };
  const timerRoutes = routes.filter((r) =>
    ["/api/v1/sla/", "/api/v1/admin/sla/", "/api/v1/admin/settings/"].some((p) => (r.path + "/").startsWith(p))
  );
  expect(timerRoutes.length).toBeGreaterThanOrEqual(5);
  for (const user of [customer, marketing]) {
    expect(timerRoutes.filter((r) => evaluateAccess({ user, method: r.method, originalUrl: r.url }).allowed)).toEqual([]);
  }
});

test("customers reach only their own report and rating routes, never admin review", () => {
  const reachable = allowedForCustomer.filter((r) => /^\/api\/v1\/(reports|ratings|admin\/reports)/.test(r.path)).map((r) => `${r.method} ${r.path}`);
  expect(reachable.sort()).toEqual(
    [
      "GET /api/v1/ratings/:conversationId/mine",
      "GET /api/v1/reports/about-me",
      "GET /api/v1/reports/mine",
      "POST /api/v1/reports/",
      "POST /api/v1/reports/:id/response",
      "PUT /api/v1/ratings/:conversationId"
    ].sort()
  );
});

test("customers can fetch the word list and count a prevented message, but not manage moderation", () => {
  const paths = allowedForCustomer.filter((r) => r.path.includes("moderation")).map((r) => `${r.method} ${r.path}`).sort();
  expect(paths).toEqual(["GET /api/v1/moderation/lexicon", "POST /api/v1/moderation/prevented"]);
});

test("customers reach only the approval answer, timeline and testimonials among Phase 8 routes", () => {
  const phase8 = allowedForCustomer
    .filter((r) => ["approvals", "/projects/", "testimonials", "quick-replies", "admin/leads"].some((k) => r.path.includes(k)))
    .map((r) => `${r.method} ${r.path}`)
    .sort();
  expect(phase8).toEqual([
    "GET /api/v1/chat/conversations/:id/approvals",
    "GET /api/v1/projects/mine",
    "GET /api/v1/testimonials/",
    "POST /api/v1/chat/approvals/:id/decision"
  ]);
});


// ── Leadership role and add-on permissions (org structure, Phase C) ───────────

const { permissionRules } = require("../src/config/permissions");
const allowedFor = (user) => routes.filter((r) => evaluateAccess({ user, method: r.method, originalUrl: r.url }).allowed);
const key = (r) => `${r.method} ${r.path}`;

test("customers can't reach any org route", () => {
  expect(allowedForCustomer.filter((r) => r.path.startsWith("/api/v1/org"))).toEqual([]);
});

test("leadership reaches only read-only oversight routes (never a change outside its own account and chat)", () => {
  const leadership = { role: "leadership", isTwoFactorEnabled: true, mustChangePassword: false, permissions: [] };
  const reach = allowedFor(leadership);
  const writes = reach.filter(
    (r) =>
      r.method !== "GET" &&
      !/^\/api\/v1\/(auth|notifications|chat|moderation|push|privacy)(\/|$)/.test(r.path) &&
      !["/api/v1/users/profile", "/api/v1/uploads/avatar"].includes(r.path)
  );
  expect(writes.map(key)).toEqual([]);
  const admin = reach.filter((r) => r.path.startsWith("/api/v1/admin")).map(key).sort();
  expect(admin).toEqual(
    [
      "GET /api/v1/admin/leads/",
      "GET /api/v1/admin/monitoring/designers",
      "GET /api/v1/admin/monitoring/overview",
      "GET /api/v1/admin/payments/",
      "GET /api/v1/admin/payments/:projectId",
      "GET /api/v1/admin/projects/",
      "GET /api/v1/admin/projects/:id",
      "GET /api/v1/admin/sla/metrics"
    ].sort()
  );
  // Never customer personal records, settings, users, tasks or audit logs
  for (const p of ["/api/v1/admin/monitoring/customers", "/api/v1/admin/settings", "/api/v1/users/", "/api/v1/tasks/", "/api/v1/dashboard/audit-logs"]) {
    expect(reach.filter((r) => r.path.startsWith(p) && r.path !== "/api/v1/users/profile").map(key)).toEqual([]);
  }
});

test("an add-on permission opens exactly its routes for an allow-listed role", () => {
  const plain = { role: "marketing", isTwoFactorEnabled: true, mustChangePassword: false, permissions: [] };
  const finance = { ...plain, permissions: ["payments.confirm"] };
  const gained = allowedFor(finance).filter((r) => !allowedFor(plain).some((x) => key(x) === key(r))).map(key).sort();
  expect(gained).toEqual(
    [
      "GET /api/v1/admin/payments/",
      "GET /api/v1/admin/payments/:projectId",
      "POST /api/v1/admin/payments/:projectId/milestones/:milestoneId/confirm",
      "POST /api/v1/admin/payments/:projectId/milestones/:milestoneId/reject"
    ].sort()
  );
});

test("add-on permissions never apply to customers", () => {
  const sneaky = { ...customer, permissions: ["payments.confirm", "leads.manage"] };
  expect(allowedFor(sneaky).map(key).sort()).toEqual(allowedForCustomer.map(key).sort());
});

test("holding an add-on permission requires 2FA when it's enforced", () => {
  const prev = process.env.ENFORCE_PRIVILEGED_2FA;
  process.env.ENFORCE_PRIVILEGED_2FA = "true";
  try {
    const designer = { role: "user", isTwoFactorEnabled: false, mustChangePassword: false, permissions: [] };
    expect(evaluateAccess({ user: designer, method: "GET", originalUrl: "/api/v1/tasks" }).allowed).toBe(true);
    const granted = { ...designer, permissions: ["leads.view"] };
    expect(evaluateAccess({ user: granted, method: "GET", originalUrl: "/api/v1/tasks" }).code).toBe("TWO_FACTOR_REQUIRED");
    const leadership = { role: "leadership", isTwoFactorEnabled: false, mustChangePassword: false };
    expect(evaluateAccess({ user: leadership, method: "GET", originalUrl: "/api/v1/admin/monitoring/overview" }).code).toBe("TWO_FACTOR_REQUIRED");
  } finally {
    process.env.ENFORCE_PRIVILEGED_2FA = prev;
  }
});

test("every leadership and permission rule matches a real route (no stale rules)", () => {
  const all = { role: "user", permissions: require("../src/config/permissions").PERMISSION_KEYS };
  const rules = [...ROLE_ALLOW_LISTS.leadership, ...permissionRules(all)];
  const stale = rules.filter((rule) => !routes.some((r) => (rule.method === "*" || rule.method === r.method) && rule.regex.test(normalisePath(r.url))));
  expect(stale.map((r) => `${r.method} ${r.regex}`)).toEqual([]);
});
