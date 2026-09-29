const { z } = require("zod");

const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const severity = z.enum(["mild", "abusive", "threat"]);

const addTermSchema = z.object({
  body: z
    .object({
      display: z.string().trim().min(2).max(60).transform((v) => v.replace(/[\u0000-\u001F\u007F]/g, "")),
      severity,
      language: z.enum(["en", "hi", "hinglish", "other"]).optional().default("other")
    })
    .strict()
});

const updateTermSchema = z.object({
  params: z.object({ id }),
  body: z.object({ severity: severity.optional(), active: z.boolean().optional() }).strict().refine((b) => Object.keys(b).length > 0, "Nothing to update")
});

const termIdSchema = z.object({ params: z.object({ id }) });

const listIncidentsSchema = z.object({ query: z.object({ status: z.enum(["open", "resolved"]).optional() }).strict() });

const incidentActionSchema = z.object({
  params: z.object({ id }),
  body: z
    .object({
      action: z.enum(["resolve", "request_evidence"]),
      note: z.string().trim().max(2000).optional().default("")
    })
    .strict()
});

const preventedSchema = z.object({ body: z.object({}).strict().optional() });

module.exports = { addTermSchema, updateTermSchema, termIdSchema, listIncidentsSchema, incidentActionSchema, preventedSchema };
