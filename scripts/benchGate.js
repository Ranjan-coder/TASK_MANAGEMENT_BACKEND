/**
 * Benchmark of the per-request access checks (module-access-plan.md, Phase 5).
 *
 *   node scripts/benchGate.js
 *
 * Measures, over the app's real route table:
 *   - the module gate (prefix trie + organisation and person masks)
 *   - the same lookup done the naive way (testing a list of regexes in turn), for comparison
 *   - an entitlement cache hit (what every request pays after the first)
 * No database or network: pure CPU cost per request.
 */
process.env.NODE_ENV = "test";
const { performance } = require("perf_hooks");
const { MODULE_ROUTES, moduleForPath } = require("../src/config/moduleRoutes");
const { checkModuleAccess } = require("../src/middlewares/moduleGate");
const modules = require("../src/config/modules");

const SAMPLE_ID = "64b7f0c2a1b2c3d4e5f60718";
const ROUTES = [
  "/api/v1/tasks", `/api/v1/tasks/${SAMPLE_ID}/comments`, "/api/v1/chat/conversations", `/api/v1/chat/conversations/${SAMPLE_ID}/messages`,
  "/api/v1/admin/monitoring/overview", "/api/v1/admin/monitoring/customers", `/api/v1/campaigns/${SAMPLE_ID}/lead`, "/api/v1/campaigns/live",
  `/api/v1/admin/payments/${SAMPLE_ID}/milestones/${SAMPLE_ID}/confirm`, "/api/v1/notifications", "/api/v1/uploads/avatar", "/api/v1/users",
  "/api/v1/org/chart", "/api/v1/reports/mine", "/api/v1/moderation/lexicon", "/api/v1/referrals/mine"
];

// The naive alternative: one regex per mapped prefix, tried in order (longest first)
const naive = MODULE_ROUTES.map(([p, key]) => [new RegExp(`^${p.replace(/:[a-z]+/gi, "[^/]+")}(/|$)`), key, p.length]).sort((a, b) => b[2] - a[2]);
const naiveLookup = (path) => naive.find(([re]) => re.test(path))?.[1] ?? null;

const N = 1_000_000;
const time = (label, fn) => {
  for (let i = 0; i < 20_000; i++) fn(i); // warm up the JIT
  const t0 = performance.now();
  for (let i = 0; i < N; i++) fn(i);
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(44)} ${((ms * 1e6) / N).toFixed(0).padStart(6)} ns/op   (${(N / (ms / 1000) / 1e6).toFixed(2)} M ops/s)`);
};

const orgMask = modules.effectiveMask(modules.ALL_MASK);
const staff = { role: "user", moduleAccess: { keys: ["tasks", "projects", "chat", "leads", "marketing"] } };
const paths = ROUTES.map((r) => r.replace("/api/v1", ""));

console.log(`Route patterns: ${MODULE_ROUTES.length}; sample paths: ${ROUTES.length}; iterations: ${N.toLocaleString()}\n`);
time("trie lookup (moduleForPath)", (i) => moduleForPath(paths[i % paths.length]));
time("naive regex list lookup", (i) => naiveLookup(paths[i % paths.length]));
time("full gate: normalise + trie + both masks", (i) => checkModuleAccess({ user: staff, originalUrl: ROUTES[i % ROUTES.length], orgMask }));

// Entitlement cache hit: what organisation.service.getEntitlements does after the first request
const cache = new Map([["org", { org: { status: "active" }, at: Date.now(), ent: { mask: orgMask, validUntil: Infinity } }]]);
time("entitlement cache hit (Map get + expiry check)", () => {
  const e = cache.get("org");
  return Date.now() - e.at < 30000 && Date.now() < e.ent.validUntil ? e.ent.mask : 0;
});

// Sanity: both lookups agree on every sample
const disagree = paths.filter((p) => moduleForPath(p) !== naiveLookup(p));
console.log(`\nTrie and regex list agree on all samples: ${disagree.length === 0 ? "yes" : `NO (${disagree.join(", ")})`}`);
