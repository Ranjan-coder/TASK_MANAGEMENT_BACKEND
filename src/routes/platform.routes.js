const express = require("express");
const { z } = require("zod");
const authMiddleware = require("../middlewares/auth.middleware");
const rbacMiddleware = require("../middlewares/rbac.middleware");
const validate = require("../middlewares/validate.middleware");
const { createLimiter } = require("../middlewares/rateLimiter.middleware");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { PLATFORM_OWNER } = require("../config/roles");
const { TOGGLEABLE_KEYS } = require("../config/modules");
const { SLUG_RE, RESERVED_SLUGS, DISPLAY_NAME_RE } = require("../models/Organisation");
const { authKeySchema, saltSchema } = require("../utils/kdf");
const platform = require("../services/platform.service");

/**
 * /platform: the product owner's console (module-access-plan.md, Phase 2).
 * Only the platform_owner role; everyone else is refused here and by accessPolicy.
 */
const router = express.Router();
router.use(authMiddleware, rbacMiddleware(PLATFORM_OWNER));
// Writes are rare; a tight limit blunts a stolen session
router.use(createLimiter({ windowMs: 15 * 60 * 1000, max: 300, message: "Too many requests. Please wait a few minutes." }));

const ok = (res, data, message, status = 200) => res.status(status).json(new ApiResponse(status, data, message));
const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const name = z.string().trim().min(2, "Name must be at least 2 characters").max(120);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_RE, "Use 3–40 lowercase letters, numbers and dashes")
  .refine((v) => !RESERVED_SLUGS.includes(v), "That organisation code is reserved");
const moduleKey = z.enum(TOGGLEABLE_KEYS);

const listSchema = z.object({
  query: z
    .object({
      search: z.string().trim().max(80).optional(),
      status: z.enum(["active", "suspended"]).optional()
    })
    .strict()
});

const createSchema = z.object({
  body: z
    .object({
      name,
      slug,
      modules: z.array(moduleKey).max(TOGGLEABLE_KEYS.length).default([]),
      // The first superadmin. The initial password is turned into an authKey in the
      // product owner's browser and must be changed at first sign-in.
      superadmin: z
        .object({
          name: z.string().trim().min(2).max(100),
          email: z.string().trim().toLowerCase().email("Invalid email address").max(254),
          authKey: authKeySchema,
          kdfSalt: saltSchema
        })
        .strict()
    })
    .strict()
});

const updateSchema = z.object({
  params: z.object({ id }).strict(),
  body: z
    .object({
      name: name.optional(),
      status: z.enum(["active", "suspended"]).optional(),
      // Branding: shown instead of the product name while the branding module is on.
      // Empty or null clears it.
      displayName: z
        .string()
        .trim()
        .transform((v) => v || null)
        .pipe(z.string().regex(DISPLAY_NAME_RE, "Use 2–60 characters, without < or >").nullable())
        .nullable()
        .optional()
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change" })
});

const moduleSchema = z.object({
  params: z.object({ id, key: moduleKey }).strict(),
  body: z
    .object({
      enabled: z.boolean().optional(),
      expiresAt: z.coerce
        .date()
        .refine((d) => d.getTime() > Date.now(), "The end date must be in the future")
        .nullable()
        .optional(),
      seatLimit: z.number().int().min(1).max(100000).nullable().optional()
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change" })
});

router.get("/modules", (req, res) => ok(res, platform.listModules()));
router.get("/organisations", validate(listSchema), asyncHandler(async (req, res) => ok(res, await platform.listOrganisations(req.query))));
router.post(
  "/organisations",
  validate(createSchema),
  asyncHandler(async (req, res) => ok(res, await platform.createOrganisation(req.body, req), "Organisation created", 201))
);
router.get("/organisations/:id", validate(z.object({ params: z.object({ id }).strict() })), asyncHandler(async (req, res) => ok(res, await platform.getOrganisation(req.params.id))));
router.patch(
  "/organisations/:id",
  validate(updateSchema),
  asyncHandler(async (req, res) => ok(res, await platform.updateOrganisation(req.params.id, req.body, req), "Organisation updated"))
);
router.put(
  "/organisations/:id/modules/:key",
  validate(moduleSchema),
  asyncHandler(async (req, res) => ok(res, await platform.setModule(req.params.id, req.params.key, req.body, req), "Module updated"))
);
router.get("/audit", asyncHandler(async (req, res) => ok(res, await platform.listPlatformAudit())));

// ── Standard departments and designations (every organisation's starting list) ──
// A change reaches every organisation except fields it changed itself; a new item
// is added to every organisation (services/orgTemplate.service.js).
{
  const v = require("../validators/org.validator");
  const template = require("../services/orgTemplate.service");
  const { recordAuditLog } = require("../services/audit.service");
  const audit = (req, action, targetId, metadata) => recordAuditLog({ req, action, targetType: "OrgTemplate", targetId, metadata });

  router.get("/org-template", asyncHandler(async (req, res) => ok(res, await template.listTemplate())));

  for (const kind of ["department", "designation"]) {
    const base = `/org-template/${kind}s`;
    const createSchema = kind === "department" ? v.templateDepartmentCreateSchema : v.createDesignationSchema;
    const updateSchema = kind === "department" ? v.templateDepartmentUpdateSchema : v.updateDesignationSchema;

    router.post(
      base,
      validate(createSchema),
      asyncHandler(async (req, res) => {
        const { item, companies } = await template.createTemplateItem(kind, req.user, req.body);
        await audit(req, `template_${kind}_created`, item._id, { name: item.name, companies });
        ok(res, { item, companies }, `Added to the standard list and to ${companies} organisation${companies === 1 ? "" : "s"}`, 201);
      })
    );
    router.patch(
      `${base}/:id`,
      validate(updateSchema),
      asyncHandler(async (req, res) => {
        const { before, after, changed, companies, kept } = await template.updateTemplateItem(kind, req.user, req.params.id, req.body);
        await audit(req, `template_${kind}_updated`, after._id, { name: after.name, changed, companies, kept, before: Object.fromEntries(changed.map((f) => [f, before[f]])) });
        ok(res, { item: after, changed, companies, kept }, "Standard list updated");
      })
    );
    router.delete(
      `${base}/:id`,
      validate(v.idOnlySchema),
      asyncHandler(async (req, res) => {
        const { item, detached } = await template.deleteTemplateItem(kind, req.params.id);
        await audit(req, `template_${kind}_deleted`, item._id, { name: item.name, detached });
        ok(res, { detached }, "Removed from the standard list");
      })
    );
  }
}

module.exports = router;
