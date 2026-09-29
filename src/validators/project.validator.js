const { z } = require("zod");

const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const optionalId = id.nullable().optional();
const name = z
  .string()
  .trim()
  .min(3, "Project name must be at least 3 characters")
  .max(100)
  .transform((v) => v.replace(/[\u0000-\u001F\u007F]/g, ""));

const team = {
  customerIds: z.array(id).min(1, "Add at least one customer").max(10),
  leadDesignerId: id,
  backupDesignerId: optionalId,
  managerId: optionalId,
  staffIds: z.array(id).max(17).optional().default([])
};

// The first group key, wrapped in the admin's browser for each member
const wrappedKey = z
  .object({
    wrapped: z.string().max(512),
    wrapperKeyVersion: z.number().int().min(0),
    recipientKeyVersion: z.number().int().min(0)
  })
  .strict();

const createProjectSchema = z.object({
  body: z
    .object({ name, ...team, encryptedGroupKeys: z.record(id, wrappedKey).optional().default({}) })
    .strict()
});

const updateProjectSchema = z.object({
  params: z.object({ id }),
  body: z.object({ name: name.optional(), status: z.enum(["active", "on_hold", "completed"]).optional(), ...team }).strict()
});

const projectIdSchema = z.object({ params: z.object({ id }) });

const listProjectsSchema = z.object({
  query: z.object({ status: z.enum(["active", "on_hold", "completed"]).optional() }).passthrough()
});

module.exports = { createProjectSchema, updateProjectSchema, projectIdSchema, listProjectsSchema };
