const { z } = require("zod");
const { B64, IV_B64 } = require("./models/encrypted");

/**
 * Request shapes for /planner (planner-module-plan.md). `.strict()` everywhere:
 * content is accepted ONLY as { ciphertext, iv } — the server refuses plain text.
 */
const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const version = z.number().int().min(1);
const enc = (maxBytes) =>
  z
    .object({
      ciphertext: z.string().max(Math.ceil((maxBytes * 4) / 3) + 4).regex(B64, "Invalid ciphertext"),
      iv: z.string().regex(IV_B64, "Invalid IV")
    })
    .strict();
const cursor = z.string().regex(/^\d{10,15}_[a-f0-9]{24}$/i, "Invalid cursor");
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const params = z.object({ id }).strict();

const vaultPutSchema = z.object({
  body: z
    .object({
      keyVersion: z.number().int().min(1),
      wrapped: z.string().max(200).regex(/^[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/, "Invalid wrapped key")
    })
    .strict()
});

// Deleting an unrecoverable Planner must be deliberate
// Deleting an unrecoverable Planner must be deliberate AND re-confirmed with the password
// (a stolen session alone must not be able to wipe someone's Planner)
const vaultResetSchema = z.object({
  body: z
    .object({
      confirm: z.literal("DELETE"),
      authKey: z.string().min(40).max(64).optional(),
      password: z.string().min(1).max(128).optional() // accounts still on the legacy scheme
    })
    .strict()
    .refine((b) => b.authKey || b.password, { message: "Enter your password", path: ["authKey"] })
});

const COLORS = ["none", "yellow", "green", "blue", "pink", "purple", "grey"];
const NOTE_BYTES = 64 * 1024;

const notesListSchema = z.object({
  query: z.object({ archived: bool.optional(), cursor: cursor.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict()
});
const noteCreateSchema = z.object({
  body: z.object({ enc: enc(NOTE_BYTES), pinned: z.boolean().optional(), color: z.enum(COLORS).optional() }).strict()
});
const noteUpdateSchema = z.object({
  params,
  body: z
    .object({
      version,
      enc: enc(NOTE_BYTES).optional(),
      pinned: z.boolean().optional(),
      color: z.enum(COLORS).optional(),
      archived: z.boolean().optional()
    })
    .strict()
});
const idOnlySchema = z.object({ params });

// ── Todos ──
const date = z.coerce.date().refine((d) => !Number.isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2100, "Invalid date");
// Neighbours of the new position (either can be left out: start / end of the list)
const move = { before: id.optional(), after: id.optional() };

const listCreateSchema = z.object({ body: z.object({ enc: enc(1024) }).strict() });
const listUpdateSchema = z.object({ params, body: z.object({ version, enc: enc(1024) }).strict() });
const listMoveSchema = z.object({ params, body: z.object(move).strict() });
const itemCreateSchema = z.object({ params, body: z.object({ enc: enc(4096), dueAt: date.nullable().optional() }).strict() });
const itemUpdateSchema = z.object({
  params,
  body: z.object({ version, enc: enc(4096).optional(), done: z.boolean().optional(), dueAt: date.nullable().optional() }).strict()
});
const itemMoveSchema = z.object({ params, body: z.object({ ...move, list: id.optional() }).strict() });
const rangeSchema = z.object({
  query: z
    .object({ from: date, to: date })
    .strict()
    .refine((q) => q.to > q.from && q.to - q.from <= 366 * 24 * 3600 * 1000, "Choose a range of up to one year")
});

// ── Reminders ──
const recurrence = z
  .object({
    freq: z.enum(["none", "daily", "weekdays", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(30).optional(),
    byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional()
  })
  .strict();
const timeZone = z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/, "Invalid time zone");
const future = date.refine((d) => d.getTime() > Date.now() - 60 * 1000, "Choose a time in the future");
const link = z.object({ kind: z.enum(["note", "item", "meeting"]), id }).strict();

const reminderListSchema = z.object({ query: z.object({ status: z.enum(["active", "done"]).optional() }).strict() });
const reminderCreateSchema = z.object({
  body: z.object({ enc: enc(1024), at: future, timeZone: timeZone.optional(), recurrence: recurrence.optional(), link: link.optional() }).strict()
});
const reminderUpdateSchema = z.object({
  params,
  body: z.object({ version, enc: enc(1024).optional(), at: future.optional(), timeZone: timeZone.optional(), recurrence: recurrence.optional() }).strict()
});
const snoozeSchema = z.object({ params, body: z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60) }).strict() });

// ── Meetings ──
const WRAPPED = /^[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/;
const attendee = z
  .object({
    user: id,
    wrapped: z.string().max(200).regex(WRAPPED, "Invalid wrapped key"),
    recipientKeyVersion: z.number().int().min(1),
    senderKeyVersion: z.number().int().min(1)
  })
  .strict();
const MEETING_BYTES = 8 * 1024;
const meetingRangeSchema = rangeSchema;
const meetingCreateSchema = z.object({
  body: z
    .object({
      startAt: future,
      endAt: date,
      timeZone: timeZone.optional(),
      enc: enc(MEETING_BYTES),
      attendees: z.array(attendee).min(1).max(51),
      reminderMinutes: z.number().int().min(0).max(1440).nullable().optional()
    })
    .strict()
});
const meetingUpdateSchema = z.object({
  params,
  body: z
    .object({
      version,
      startAt: date.optional(), // must be in the future only if it changes (checked in the service)
      endAt: date.optional(),
      timeZone: timeZone.optional(),
      enc: enc(MEETING_BYTES).optional(),
      attendees: z.array(attendee).min(1).max(51).optional(),
      reminderMinutes: z.number().int().min(0).max(1440).nullable().optional(),
      rekey: z.boolean().optional()
    })
    .strict()
});
const respondSchema = z.object({ params, body: z.object({ response: z.enum(["accepted", "tentative", "declined"]) }).strict() });
const availabilitySchema = z.object({
  query: z
    .object({
      users: z
        .string()
        .max(50 * 25)
        .transform((s) => s.split(",").filter(Boolean))
        .pipe(z.array(id).min(1).max(50)),
      from: date,
      to: date
    })
    .strict()
    .refine((q) => q.to > q.from && q.to - q.from <= 31 * 24 * 3600 * 1000, "Choose a range of up to a month")
});

const peopleSchema = z.object({ query: z.object({ q: z.string().trim().max(60).optional() }).strict() });

module.exports = {
  vaultResetSchema,
  peopleSchema,
  meetingRangeSchema,
  meetingCreateSchema,
  meetingUpdateSchema,
  respondSchema,
  availabilitySchema,
  reminderListSchema,
  reminderCreateSchema,
  reminderUpdateSchema,
  snoozeSchema,
  timeZone,
  id,
  version,
  enc,
  cursor,
  bool,
  date,
  params,
  idOnlySchema,
  vaultPutSchema,
  notesListSchema,
  noteCreateSchema,
  noteUpdateSchema,
  listCreateSchema,
  listUpdateSchema,
  listMoveSchema,
  itemCreateSchema,
  itemUpdateSchema,
  itemMoveSchema,
  rangeSchema
};
