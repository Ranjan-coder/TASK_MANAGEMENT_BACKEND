const { z } = require("zod");
const { STAFF_ROLES } = require("../config/roles");
const { PERMISSION_KEYS } = require("../config/permissions");

const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const idParams = z.object({ id }).strict();
// Letters, numbers, spaces and a few joiners (& - . / ' ( )) — no markup or control characters
const orgName = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(60)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} &\-./'()]*$/u, "Use letters, numbers, spaces and & - . / ' ( ) only");
const short = z.string().trim().max(12).regex(/^[\p{L}\p{N} &\-./]*$/u, "Use letters and numbers only");
const level = z.coerce.number().int().min(1).max(9);
const flag = z.enum(["0", "1", "true", "false"]).optional();

const listSchema = z.object({ query: z.object({ includeInactive: flag, counts: flag }).strict() });

const createDepartmentSchema = z.object({
  body: z.object({ name: orgName, description: z.string().trim().max(300).optional(), head: id.nullable().optional() }).strict()
});
const updateDepartmentSchema = z.object({
  params: idParams,
  body: z
    .object({
      name: orgName.optional(),
      description: z.string().trim().max(300).optional(),
      head: id.nullable().optional(),
      isActive: z.boolean().optional()
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, "Nothing to update")
});

const suggestedRole = z.enum(STAFF_ROLES).nullable();
const createDesignationSchema = z.object({
  body: z
    .object({
      name: orgName,
      short: short.optional(),
      level,
      departments: z.array(id).max(30).optional(),
      suggestedRole: suggestedRole.optional()
    })
    .strict()
});
const updateDesignationSchema = z.object({
  params: idParams,
  body: z
    .object({
      name: orgName.optional(),
      short: short.optional(),
      level: level.optional(),
      departments: z.array(id).max(30).optional(),
      suggestedRole: suggestedRole.optional(),
      isActive: z.boolean().optional()
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, "Nothing to update")
});

const idOnlySchema = z.object({ params: idParams });
const mergeSchema = z.object({ params: idParams, body: z.object({ into: id }).strict() });
const reorderSchema = z.object({ body: z.object({ ids: z.array(id).min(1).max(500) }).strict() });
const teamSchema = z.object({ query: z.object({ userId: id.optional() }).strict() });

const permissionsSchema = z.object({
  params: idParams,
  body: z
    .object({
      permissions: z
        .array(z.enum(PERMISSION_KEYS))
        .max(PERMISSION_KEYS.length)
        .refine((a) => new Set(a).size === a.length, "Each permission once")
    })
    .strict()
});

module.exports = {
  id,
  listSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  createDesignationSchema,
  updateDesignationSchema,
  idOnlySchema,
  mergeSchema,
  reorderSchema,
  teamSchema,
  permissionsSchema
};
