const { z } = require("zod");

const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const toMin = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));

const businessHours = z
  .object({
    start: hm,
    end: hm,
    workDays: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one working day").max(7)
  })
  .strict()
  .refine((b) => toMin(b.end) - toMin(b.start) >= 60, { message: "Closing time must be at least an hour after opening", path: ["end"] })
  .transform((b) => ({ ...b, workDays: [...new Set(b.workDays)].sort() }));

const holiday = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((d) => !Number.isNaN(Date.parse(d)), "Invalid date"),
    name: z.string().trim().max(80).transform((v) => v.replace(/[\u0000-\u001F\u007F]/g, "")).optional().default("")
  })
  .strict();

const cleanStr = (max) => z.string().max(max).transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim());

const minutes = z.number().int().min(1).max(24 * 60);
const sla = z
  .object({ autoReplyMin: minutes, remindMin: minutes, escalateMin: minutes })
  .strict()
  .refine((s) => s.autoReplyMin < s.remindMin && s.remindMin < s.escalateMin, {
    message: "Timers must increase: auto-reply < reminder < escalation"
  });

const updateSettingsSchema = z.object({
  body: z
    .object({
      businessHours: businessHours.optional(),
      holidays: z
        .array(holiday)
        .max(100)
        .optional()
        .transform((list) => (list ? [...new Map(list.map((h) => [h.date, h])).values()].sort((a, b) => a.date.localeCompare(b.date)) : list)),
      sla: sla.optional(),
      escalationContacts: z.array(id).max(20).optional(),
      payments: z
        .object({
          companyName: cleanStr(120),
          companyAddress: cleanStr(300),
          gstin: z.string().trim().toUpperCase().regex(/^$|^[0-9]{2}[A-Z0-9]{13}$/, "GSTIN has 15 characters"),
          upiId: z.string().trim().regex(/^$|^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z]{2,64}$/, "Enter a UPI ID like bonito@okhdfc"),
          bankName: cleanStr(80),
          accountName: cleanStr(80),
          accountNumber: z.string().trim().regex(/^$|^[0-9]{6,20}$/, "Account number should be 6–20 digits"),
          ifsc: z.string().trim().toUpperCase().regex(/^$|^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC looks like HDFC0001234"),
          instructions: cleanStr(500)
        })
        .strict()
        .optional(),
      referrals: z
        .object({ enabled: z.boolean(), referrerReward: cleanStr(120), friendReward: cleanStr(120), terms: cleanStr(600) })
        .strict()
        .optional(),
      moderation: z
        .object({ threshold: z.number().int().min(2).max(50), window: z.number().int().min(10).max(500) })
        .strict()
        .refine((m) => m.threshold <= m.window, "The threshold can't be larger than the window")
        .optional()
    })
    .strict()
});

const metricsSchema = z.object({
  query: z.object({ days: z.coerce.number().int().min(1).max(365).optional().default(30) }).strict()
});

const slaIdSchema = z.object({ params: z.object({ id }) });

module.exports = { updateSettingsSchema, metricsSchema, slaIdSchema };
