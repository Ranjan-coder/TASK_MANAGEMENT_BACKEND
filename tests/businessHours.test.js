const bh = require("../src/utils/businessHours");

// Default: Tue–Sun 10:00–19:00 IST, Monday off
const cfg = bh.toConfig({});
// IST = UTC+5:30, so 10:00 IST = 04:30Z and 19:00 IST = 13:30Z
const ist = (s) => new Date(`${s}+05:30`);

describe("business hours (IST, Monday off)", () => {
  test("2026-09-29 is a Tuesday (sanity check for the dates below)", () => {
    expect(bh.localDay(+ist("2026-09-29T12:00:00"), cfg).weekday).toBe(2);
  });

  test("working time checks", () => {
    expect(bh.isWorkingTime(ist("2026-09-29T10:00:00"), cfg)).toBe(true);
    expect(bh.isWorkingTime(ist("2026-09-29T09:59:00"), cfg)).toBe(false);
    expect(bh.isWorkingTime(ist("2026-09-29T19:00:00"), cfg)).toBe(false);
    expect(bh.isWorkingTime(ist("2026-09-28T12:00:00"), cfg)).toBe(false); // Monday
    expect(bh.isWorkingTime(ist("2026-10-04T12:00:00"), cfg)).toBe(true); // Sunday
  });

  test("adds minutes inside one day", () => {
    expect(bh.addWorkingMinutes(ist("2026-09-29T11:00:00"), 15, cfg)).toEqual(ist("2026-09-29T11:15:00"));
  });

  test("carries over closing time to the next morning", () => {
    expect(bh.addWorkingMinutes(ist("2026-09-29T18:30:00"), 60, cfg)).toEqual(ist("2026-09-30T10:30:00"));
  });

  test("ending exactly at closing time stays that day", () => {
    expect(bh.addWorkingMinutes(ist("2026-09-29T18:00:00"), 60, cfg)).toEqual(ist("2026-09-29T19:00:00"));
  });

  test("skips Monday: Sunday evening → Tuesday morning", () => {
    expect(bh.addWorkingMinutes(ist("2026-10-04T18:50:00"), 20, cfg)).toEqual(ist("2026-10-06T10:10:00"));
  });

  test("a message at 11 pm starts the clock at the next opening", () => {
    expect(bh.nextWorkingStart(ist("2026-09-29T23:00:00"), cfg)).toEqual(ist("2026-09-30T10:00:00"));
    expect(bh.nextWorkingStart(ist("2026-09-28T12:00:00"), cfg)).toEqual(ist("2026-09-29T10:00:00")); // Monday
  });

  test("skips holidays", () => {
    const withHoliday = bh.toConfig({ holidays: [{ date: "2026-09-30" }] });
    expect(bh.addWorkingMinutes(ist("2026-09-29T18:30:00"), 60, withHoliday)).toEqual(ist("2026-10-01T10:30:00"));
  });

  test("measures working time across nights and days off", () => {
    const ms = bh.workingMsBetween(ist("2026-10-04T18:00:00"), ist("2026-10-06T10:30:00"), cfg);
    expect(ms / 60000).toBe(90);
  });

  test("describes the hours and the next reply time", () => {
    expect(bh.describeHours(cfg)).toBe("10 AM–7 PM, Tuesday to Sunday");
    expect(bh.describeHours(bh.toConfig({ businessHours: { start: "09:30", end: "18:00", workDays: [1, 2, 3, 4, 5, 6] } }))).toBe(
      "9:30 AM–6 PM, Monday to Saturday"
    );
    const now = ist("2026-09-29T23:00:00");
    expect(bh.describeWhen(ist("2026-09-30T10:00:00"), now, cfg)).toBe("tomorrow at 10 AM");
    expect(bh.describeWhen(ist("2026-10-06T10:00:00"), ist("2026-10-04T20:00:00"), cfg)).toBe("on Tuesday at 10 AM");
    expect(bh.describeWhen(ist("2026-09-29T10:00:00"), ist("2026-09-29T07:00:00"), cfg)).toBe("today at 10 AM");
  });

  test("no working days: gives up instead of looping", () => {
    const none = { ...cfg, workDays: [9] };
    expect(bh.addWorkingMinutes(ist("2026-09-29T10:00:00"), 15, none)).toBeNull();
  });
});

describe("settings validation", () => {
  const { updateSettingsSchema } = require("../src/validators/settings.validator");
  const parse = (body) => updateSettingsSchema.safeParse({ body });

  test("accepts the defaults", () => {
    expect(parse({ businessHours: { start: "10:00", end: "19:00", workDays: [0, 2, 3, 4, 5, 6] }, sla: { autoReplyMin: 15, remindMin: 60, escalateMin: 120 } }).success).toBe(true);
  });
  test("rejects timers out of order, bad times, no working days and unknown fields", () => {
    expect(parse({ sla: { autoReplyMin: 60, remindMin: 15, escalateMin: 120 } }).success).toBe(false);
    expect(parse({ businessHours: { start: "25:00", end: "19:00", workDays: [2] } }).success).toBe(false);
    expect(parse({ businessHours: { start: "10:00", end: "10:30", workDays: [2] } }).success).toBe(false);
    expect(parse({ businessHours: { start: "10:00", end: "19:00", workDays: [] } }).success).toBe(false);
    expect(parse({ businessHours: { start: "10:00", end: "19:00", workDays: [2], utcOffsetMinutes: 0 } }).success).toBe(false);
    expect(parse({ escalationContacts: ["not-an-id"] }).success).toBe(false);
    expect(parse({ role: "superadmin" }).success).toBe(false);
  });
  test("dedupes and sorts holidays", () => {
    const r = parse({ holidays: [{ date: "2026-11-08", name: "Diwali" }, { date: "2026-10-20" }, { date: "2026-11-08", name: "Diwali 2" }] });
    expect(r.data.body.holidays.map((h) => h.date)).toEqual(["2026-10-20", "2026-11-08"]);
  });
});
