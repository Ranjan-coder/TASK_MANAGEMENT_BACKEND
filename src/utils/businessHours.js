/**
 * Working-time arithmetic for the reply timers.
 *
 * Config: { utcOffsetMinutes, startMinute, endMinute, workDays: [0-6, Sun=0], holidays: Set<"YYYY-MM-DD"> }
 * India has no daylight saving, so a fixed offset (IST = +330) is exact.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const MAX_DAYS = 400; // stop scanning after ~a year (e.g. every day marked a holiday)

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const parseHm = (hm) => {
  const [h, m] = String(hm).split(":").map(Number);
  return h * 60 + m;
};

/** Builds the arithmetic config from the stored settings. */
const toConfig = ({ businessHours = {}, holidays = [] } = {}) => ({
  utcOffsetMinutes: businessHours.utcOffsetMinutes ?? 330,
  startMinute: parseHm(businessHours.start || "10:00"),
  endMinute: parseHm(businessHours.end || "19:00"),
  workDays: businessHours.workDays?.length ? businessHours.workDays : [0, 2, 3, 4, 5, 6],
  holidays: new Set(holidays.map((h) => h.date))
});

/** The local day containing `ms`: its UTC start, weekday and date string. */
const localDay = (ms, cfg) => {
  const off = cfg.utcOffsetMinutes * MIN_MS;
  const shiftedStart = Math.floor((ms + off) / DAY_MS) * DAY_MS;
  const d = new Date(shiftedStart);
  return { start: shiftedStart - off, weekday: d.getUTCDay(), ymd: d.toISOString().slice(0, 10) };
};

/** Working window [open, close) of the local day starting at dayStart, or null if it's a day off. */
const windowFor = (dayStart, cfg) => {
  const day = localDay(dayStart, cfg);
  if (!cfg.workDays.includes(day.weekday) || cfg.holidays.has(day.ymd)) return null;
  return { open: day.start + cfg.startMinute * MIN_MS, close: day.start + cfg.endMinute * MIN_MS };
};

const isWorkingTime = (date, cfg) => {
  const ms = +date;
  const w = windowFor(localDay(ms, cfg).start, cfg);
  return Boolean(w && ms >= w.open && ms < w.close);
};

/** The moment `minutes` of working time have passed after `from`. addWorkingMinutes(d, 0) = next opening. */
const addWorkingMinutes = (from, minutes, cfg) => {
  let remaining = minutes * MIN_MS;
  let cursor = +from;
  let dayStart = localDay(cursor, cfg).start;
  for (let i = 0; i < MAX_DAYS; i++, dayStart += DAY_MS) {
    const w = windowFor(dayStart, cfg);
    if (!w) continue;
    const start = Math.max(cursor, w.open);
    if (start >= w.close) continue;
    if (start + remaining <= w.close) return new Date(start + remaining);
    remaining -= w.close - start;
    cursor = w.close;
  }
  return null;
};

const nextWorkingStart = (from, cfg) => addWorkingMinutes(from, 0, cfg);

/** Working milliseconds between two moments. */
const workingMsBetween = (a, b, cfg) => {
  let from = +a;
  const to = +b;
  if (to <= from) return 0;
  let total = 0;
  let dayStart = localDay(from, cfg).start;
  for (let i = 0; i < MAX_DAYS && dayStart < to; i++, dayStart += DAY_MS) {
    const w = windowFor(dayStart, cfg);
    if (!w) continue;
    const s = Math.max(from, w.open);
    const e = Math.min(to, w.close);
    if (e > s) total += e - s;
  }
  return total;
};

const formatClock = (minute) => {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const h12 = h % 12 || 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
};

/** "Tuesday to Sunday" / "Monday to Saturday" / "Mon, Wed, Fri". */
const describeDays = (workDays) => {
  const days = [...new Set(workDays)].sort((x, y) => x - y);
  if (days.length === 7) return "every day";
  // Find a single run in the circular week (e.g. Tue..Sun)
  for (let startIdx = 0; startIdx < days.length; startIdx++) {
    const first = days[startIdx];
    const run = days.map((_, k) => (first + k) % 7);
    if (run.every((d) => days.includes(d)) && days.length > 1) {
      return `${DAY_NAMES[first]} to ${DAY_NAMES[(first + days.length - 1) % 7]}`;
    }
  }
  return days.map((d) => DAY_NAMES[d].slice(0, 3)).join(", ");
};

const describeHours = (cfg) =>
  `${formatClock(cfg.startMinute)}–${formatClock(cfg.endMinute)}, ${describeDays(cfg.workDays)}`;

/** "today at 10 AM" / "tomorrow at 10 AM" / "on Tuesday at 10 AM". */
const describeWhen = (target, now, cfg) => {
  const t = localDay(+target, cfg);
  const n = localDay(+now, cfg);
  const clock = formatClock(Math.round((+target - t.start) / MIN_MS));
  const diffDays = Math.round((t.start - n.start) / DAY_MS);
  if (diffDays === 0) return `today at ${clock}`;
  if (diffDays === 1) return `tomorrow at ${clock}`;
  return `on ${DAY_NAMES[t.weekday]} at ${clock}`;
};

module.exports = {
  toConfig,
  isWorkingTime,
  addWorkingMinutes,
  nextWorkingStart,
  workingMsBetween,
  describeHours,
  describeWhen,
  localDay
};
