/**
 * CPU cost of the Planner's per-request logic (planner-module-plan.md).
 *
 *   node scripts/benchPlanner.js
 */
process.env.NODE_ENV = "test";
const { performance } = require("perf_hooks");
const { between } = require("../src/modules/planner/rank");
const { nextOccurrence } = require("../src/modules/planner/recurrence");
const { mergeIntervals } = require("../src/modules/planner/meetings.service");

const N = 200_000;
const time = (label, fn, n = N) => {
  for (let i = 0; i < 2000; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(52)} ${((ms * 1e6) / n).toFixed(0).padStart(7)} ns/op`);
};

// Moving a todo: one rank between two neighbours
const keys = [];
let k = "";
for (let i = 0; i < 1000; i++) keys.push((k = between(k, null)));
time("rank between two neighbours (1,000-item list)", (i) => between(keys[i % 999], keys[(i % 999) + 1]));

const at = new Date("2026-10-05T09:00:00+05:30");
time("next occurrence: daily, Asia/Kolkata", () => nextOccurrence(at, { freq: "daily" }, "Asia/Kolkata"), 20_000);
time("next occurrence: weekly Mon/Wed/Fri, Europe/London", () => nextOccurrence(at, { freq: "weekly", byWeekday: [1, 3, 5] }, "Europe/London"), 20_000);

// Busy times: 50 people x 20 meetings each, merged
const intervals = Array.from({ length: 1000 }, (_, i) => [i * 1800e3 + (i % 3) * 600e3, i * 1800e3 + 3600e3]);
time("merge 1,000 busy intervals (sort + one pass)", () => mergeIntervals(intervals), 2000);
