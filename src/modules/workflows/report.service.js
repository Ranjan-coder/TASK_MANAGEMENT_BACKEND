const Conversation = require("../../models/Conversation");
const workflows = require("./workflow.service");

/**
 * E2: how long projects really spend in each stage (project-workflow-plan.md §13).
 *
 * Built from the stage history the app already records, so staff enter nothing.
 * One query (projection: only stage, history times and status), then one pass:
 * each project's history becomes a list of (stage, entered) points; the time in a
 * stage is the gap to the next point with a different stage. Per stage we keep the
 * durations and take average and median (sort per stage: O(n log n) overall).
 * Projects still in a stage count as "now" (and "overdue" past their due date),
 * not as a finished duration.
 */
const DAY = 24 * 60 * 60 * 1000;
const STAGE_MOVES = new Set(["next", "back", "jump", "migrate"]);

const median = (sorted) => (sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null);
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

const stageReport = async ({ days = 180, now = new Date() } = {}) => {
  const since = new Date(now.getTime() - days * DAY);
  const [c, projects] = await Promise.all([
    workflows.currentCompiled(),
    Conversation.find({ project: { $exists: true, $ne: null }, $or: [{ lastActivityAt: { $gte: since } }, { "project.status": "active" }] })
      .select("project.stage project.status project.createdAt project.flow.dueAt project.stageHistory.stage project.stageHistory.at project.stageHistory.kind createdAt")
      .limit(5000)
      .lean()
  ]);

  const durations = new Map(); // stageKey → [days]
  const now_ = new Map(); // stageKey → projects currently there
  const overdue = new Map();
  const add = (m, k, v = 1) => m.set(k, (m.get(k) || 0) + v);

  for (const p of projects) {
    const pr = p.project;
    // Stage moves only (older entries without a kind were always stage moves)
    const moves = (pr.stageHistory || []).filter((h) => h.stage && (!h.kind || STAGE_MOVES.has(h.kind)));
    // Where it started: the "from" of its first move, or where it is if it never moved
    const firstFrom = moves.find((h) => h.from)?.from;
    const start = moves.length ? (firstFrom ? String(firstFrom).split("/")[0] : c.stages[0].key) : pr.stage;
    const points = [{ stage: start, at: new Date(pr.createdAt || p.createdAt) }];
    for (const h of moves) if (points.at(-1).stage !== h.stage) points.push({ stage: h.stage, at: new Date(h.at) });
    for (let i = 0; i < points.length - 1; i += 1) {
      const d = (points[i + 1].at - points[i].at) / DAY;
      if (d >= 0 && points[i + 1].at >= since) {
        if (!durations.has(points[i].stage)) durations.set(points[i].stage, []);
        durations.get(points[i].stage).push(d);
      }
    }
    if (pr.status === "active") {
      add(now_, pr.stage);
      if (pr.flow?.dueAt && new Date(pr.flow.dueAt) < now) add(overdue, pr.stage);
    }
  }

  const row = (key, name, target) => {
    const list = (durations.get(key) || []).sort((a, b) => a - b);
    const avg = list.length ? list.reduce((s, x) => s + x, 0) / list.length : null;
    return {
      stage: key,
      name,
      targetDays: target ?? null,
      finished: list.length,
      averageDays: round1(avg),
      medianDays: round1(median(list)),
      overTargetPct: target && list.length ? Math.round((list.filter((x) => x > target).length / list.length) * 100) : null,
      inStageNow: now_.get(key) || 0,
      overdueNow: overdue.get(key) || 0
    };
  };
  const rows = c.stages.map((s) => row(s.key, s.name, s.durationDays));
  // Stages that only exist in older versions still show up
  for (const k of new Set([...durations.keys(), ...now_.keys()])) if (!c.stageIndex.has(k)) rows.push({ ...row(k, `${k} (older version)`, null), older: true });

  // Bottleneck: the stage furthest over its target; if none is over, the slowest on average
  const measured = rows.filter((r) => r.averageDays !== null);
  const over = measured.filter((r) => r.targetDays && r.averageDays > r.targetDays);
  const pick = (list, score) => list.reduce((best, r) => (!best || score(r) > score(best) ? r : best), null);
  const worst = over.length ? pick(over, (r) => r.averageDays / r.targetDays) : pick(measured, (r) => r.averageDays);

  return { days, projects: projects.length, rows, bottleneck: worst ? worst.stage : null };
};

module.exports = { stageReport };
