/**
 * Repeating reminders (planner-module-plan.md), computed in the person's own time
 * zone so "every Monday 9:00" stays 9:00 local time across daylight-saving changes.
 *
 * Each step is O(1) (O(7) at most for "weekly on chosen days"), computed only when
 * a reminder fires: nothing is pre-generated or stored per occurrence.
 */

const FREQS = ["none", "daily", "weekdays", "weekly", "monthly"];

// Building an Intl formatter is the expensive part (~100 µs); one per time zone is
// kept (memoised), so a lookup is a Map hit plus formatting.
const formatters = new Map();
const formatterFor = (timeZone) => {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    if (formatters.size > 500) formatters.clear(); // bounded (there are ~400 zones)
    formatters.set(timeZone, fmt);
  }
  return fmt;
};

/** Wall-clock parts of `date` in `timeZone`. */
const partsIn = (date, timeZone) => {
  const p = Object.fromEntries(formatterFor(timeZone).formatToParts(date).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second, ms: date.getUTCMilliseconds() };
};

/** UTC instant for a wall-clock time in `timeZone` (offset found by two passes, DST-safe). */
const fromZoned = ({ y, mo, d, h, mi, s = 0, ms = 0 }, timeZone) => {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const offset = (t) => {
    const p = partsIn(new Date(t), timeZone);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // second pass settles on the right side of a DST switch
  return new Date(t);
};

const isValidTimeZone = (tz) => {
  try {
    formatterFor(tz); // throws for an unknown zone; caches a valid one
    return true;
  } catch {
    return false;
  }
};

const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const weekday = ({ y, mo, d }) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 = Sunday
const addDays = (p, n) => {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + n));
  return { ...p, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/**
 * The occurrence after `from` (a Date) for a rule, or null for one-off reminders.
 * rule: { freq, interval = 1, byWeekday = [0..6], monthDay } — monthly keeps
 * monthDay (the day it was set for), clamped to short months (31st → 30th / 28th).
 */
const nextOccurrence = (from, { freq = "none", interval = 1, byWeekday = [], monthDay = null } = {}, timeZone = "Asia/Kolkata") => {
  if (freq === "none") return null;
  const p = partsIn(from, timeZone);
  let n;
  if (freq === "daily") n = addDays(p, interval);
  else if (freq === "weekdays") {
    n = addDays(p, 1);
    while ([0, 6].includes(weekday(n))) n = addDays(n, 1);
  } else if (freq === "weekly") {
    const days = new Set(byWeekday.length ? byWeekday : [weekday(p)]);
    if (interval === 1 || days.size > 1) {
      n = addDays(p, 1);
      for (let i = 0; i < 7 && !days.has(weekday(n)); i++) n = addDays(n, 1);
    } else {
      n = addDays(p, 7 * interval);
    }
  } else if (freq === "monthly") {
    const total = p.mo - 1 + interval;
    const y = p.y + Math.floor(total / 12);
    const mo = (total % 12) + 1;
    // monthDay keeps the original day: 31 Jan -> 28 Feb -> 31 Mar (no drift to the 28th)
    n = { ...p, y, mo, d: Math.min(monthDay || p.d, daysInMonth(y, mo)) };
  } else {
    return null;
  }
  return fromZoned(n, timeZone);
};

/**
 * First occurrence strictly after `now`, starting from `anchor`. Bounded, so a
 * server that was down for a while catches up with ONE reminder, not a burst.
 */
const nextAfter = (anchor, rule, timeZone, now = new Date()) => {
  let t = nextOccurrence(anchor, rule, timeZone);
  for (let i = 0; t && t <= now && i < 1000; i++) t = nextOccurrence(t, rule, timeZone);
  return t && t > now ? t : null;
};

module.exports = { FREQS, nextOccurrence, nextAfter, partsIn, fromZoned, isValidTimeZone };
