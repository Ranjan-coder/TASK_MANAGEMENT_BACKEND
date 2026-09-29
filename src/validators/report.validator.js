const { z } = require("zod");
const { REASONS, STATUSES, ACTIONS } = require("../models/Report");
const { TAGS } = require("../models/Rating");

const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
// Keep line breaks and tabs, drop other control characters
const cleanText = (min, max) =>
  z
    .string()
    .transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .pipe(z.string().min(min, `Please write at least ${min} characters`).max(max));

const ALL_REASONS = [...new Set(Object.values(REASONS).flat())];

/** The JSON part of the multipart report submission. */
const reportPayload = z
  .object({
    conversationId: id,
    reportedUserId: id,
    reason: z.enum(ALL_REASONS),
    description: cleanText(20, 2000),
    evidence: z
      .array(
        z
          .object({
            messageId: id,
            text: z.string().min(1).max(4000),
            frankingKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "Invalid franking key")
          })
          .strict()
      )
      .max(20, "Select up to 20 messages")
      .optional()
      .default([])
  })
  .strict()
  .refine((r) => new Set(r.evidence.map((e) => e.messageId)).size === r.evidence.length, "Each message can only be selected once");

const respondSchema = z.object({ params: z.object({ id }), body: z.object({ text: cleanText(10, 2000) }).strict() });

const adminListSchema = z.object({
  query: z
    .object({
      status: z.enum(STATUSES).optional(),
      direction: z.enum(Object.keys(REASONS)).optional(),
      page: z.coerce.number().int().min(1).max(1000).optional().default(1)
    })
    .strict()
});

const reportIdSchema = z.object({ params: z.object({ id }) });

const adminReviewSchema = z.object({
  params: z.object({ id }),
  body: z
    .object({
      status: z.enum(STATUSES).optional(),
      action: z.enum(ACTIONS).optional(),
      note: cleanText(1, 2000).optional(),
      requestResponse: z.literal(true).optional()
    })
    .strict()
});

const ratingSchema = z.object({
  params: z.object({ conversationId: id }),
  body: z
    .object({
      stars: z.number().int().min(1).max(5),
      tags: z.array(z.enum(TAGS)).max(TAGS.length).optional().default([]).transform((t) => [...new Set(t)]),
      comment: z
        .string()
        .max(1000)
        .optional()
        .default("")
        .transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    })
    .strict()
});

const ratingConvSchema = z.object({ params: z.object({ conversationId: id }) });

module.exports = { reportPayload, respondSchema, adminListSchema, reportIdSchema, adminReviewSchema, ratingSchema, ratingConvSchema };
