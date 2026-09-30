const { z } = require("zod");
const { ALL_ROLES } = require("../config/roles");
const { authKeySchema, saltSchema } = require("../utils/kdf");

const roleEnum = z.enum(ALL_ROLES, { required_error: "Role is required" });
// Department / designation / manager come from the managed lists (org.service.js);
// null clears them. Free-text names are no longer accepted.
const refId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id").nullable();
const orgFields = { departmentId: refId.optional(), designationId: refId.optional(), reportsTo: refId.optional() };

const createUserSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
      email: z.string().trim().toLowerCase().email("Invalid email address"),
      // Derived in the admin's browser from the initial password; the new user
      // must change it at first login (so the admin can't unlock their chat keys)
      authKey: authKeySchema,
      kdfSalt: saltSchema,
      role: roleEnum.optional(),
      ...orgFields
    })
    .strict()
});

const profileFields = {
  name: z.string().trim().min(2).max(100).optional(),
  // Only empty, https URLs, or raster data:image URLs (the upload fallback when
  // Cloudinary is off). Blocks javascript: URLs and SVG, which can carry script.
  avatarUrl: z
    .union([
      z.literal(""),
      z.string().max(2048).url().refine((u) => u.startsWith("https://"), "Avatar URL must use https"),
      z.string().max(1_400_000).regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/, "Invalid image data")
    ])
    .optional()
    .nullable(),
  // Customers: "your designer replied" alerts outside the app
  notificationPrefs: z.object({ whatsapp: z.boolean(), sms: z.boolean() }).strict().optional(),
  // Staff leave (reply reminders go to the backup designer while away)
  availability: z
    .object({
      status: z.enum(["available", "on_leave"]),
      until: z.coerce.date().nullable().optional()
    })
    .strict()
    .optional()
};

// Your own profile. Department / designation / manager are accepted here only from a
// superadmin (nobody can manage their own account elsewhere); everyone else gets a 403.
const updateProfileSchema = z.object({ body: z.object({ ...profileFields, ...orgFields }).strict() });
// An admin editing someone
const updateUserSchema = z.object({ body: z.object({ ...profileFields, ...orgFields }).strict() });

const updateRoleSchema = z.object({
  body: z.object({ role: roleEnum }).strict()
});

const updateStatusSchema = z.object({
  body: z
    .object({
      status: z.enum(["active", "inactive", "suspended"], {
        required_error: "Status is required"
      })
    })
    .strict()
});

module.exports = {
  createUserSchema,
  updateUserSchema,
  updateProfileSchema,
  updateRoleSchema,
  updateStatusSchema
};
