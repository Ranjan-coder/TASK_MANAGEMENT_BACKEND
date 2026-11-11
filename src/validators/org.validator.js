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

// The product owner's standard list: departments have no head (people belong to organisations)
const templateDepartmentCreateSchema = z.object({
  body: z.object({ name: orgName, description: z.string().trim().max(300).optional() }).strict()
});
const templateDepartmentUpdateSchema = z.object({
  params: idParams,
  body: z
    .object({ name: orgName.optional(), description: z.string().trim().max(300).optional(), isActive: z.boolean().optional() })
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

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const moduleKey = z.enum(require("../config/modules").TOGGLEABLE_KEYS);

// Phase 4: give one module to many people, or take it away
const moduleMembersSchema = z.object({
  params: z.object({ key: moduleKey }).strict(),
  body: z
    .object({ add: z.array(objectId).max(200).optional(), remove: z.array(objectId).max(200).optional() })
    .strict()
    .refine((b) => (b.add?.length || 0) + (b.remove?.length || 0) > 0, { message: "Choose at least one person" })
});

// Phase 4: one person's modules (all = every module the organisation has)
const userModulesSchema = z.object({
  params: z.object({ id: objectId }).strict(),
  body: z.object({ all: z.boolean().nullable().optional(), keys: z.array(moduleKey).max(32).optional() }).strict()
});

// Phase (planner): open a staff-only module to customers
const moduleCustomersSchema = z.object({
  params: z.object({ key: moduleKey }).strict(),
  body: z.object({ enabled: z.boolean() }).strict()
});

module.exports = {
  templateDepartmentCreateSchema,
  templateDepartmentUpdateSchema,
  moduleCustomersSchema,
  moduleMembersSchema,
  userModulesSchema,
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
