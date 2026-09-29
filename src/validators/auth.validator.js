const { z } = require("zod");
const { authKeySchema, saltSchema } = require("../utils/kdf");

// The browser encrypts the user's chat keys with a key derived from the password,
// then sends that encrypted bundle here (server cannot read it).
const keyBundleSchema = z
  .object({
    ciphertext: z.string().min(16).max(200_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/, "Invalid IV")
  })
  .strict();

// Raw password — accepted only to migrate "legacy" accounts at login
const legacyPassword = z.string().min(1).max(128);

// Password policy — enforced in the browser (the server never sees new passwords)
// and by scripts that set passwords server-side (seedAdmin.js).
const passwordPolicy = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[0-9]/, "Password must contain at least one number");

const identifierSchema = z.string().trim().min(3, "Enter your email or mobile number").max(254);

const preloginSchema = z.object({
  body: z.object({ identifier: identifierSchema }).strict()
});

// Login with email or mobile number + authKey (derived from the password in the browser).
// Legacy accounts also send the raw password once so they can be migrated.
const loginSchema = z.object({
  body: z
    .object({
      identifier: identifierSchema,
      authKey: authKeySchema,
      password: legacyPassword.optional(),
      // false on shared computers: short session, chat keys kept in memory only
      trustDevice: z.boolean().optional()
    })
    .strict()
});

const verify2FASchema = z.object({
  body: z.object({
    tempToken: z.string().min(1, "Temporary token is required"),
    code: z.string().length(6, "2FA code must be exactly 6 digits")
  })
});

const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email("Invalid email address")
  })
});

const resetPasswordSchema = z.object({
  params: z.object({
    token: z.string().min(1, "Reset token is required")
  }),
  body: z.object({ authKey: authKeySchema, kdfSalt: saltSchema }).strict()
});

const changePasswordSchema = z.object({
  body: z
    .object({
      currentAuthKey: authKeySchema.optional(),
      currentPassword: legacyPassword.optional(), // legacy accounts only
      newAuthKey: authKeySchema,
      newKdfSalt: saltSchema,
      keyBundle: keyBundleSchema.optional()
    })
    .strict()
    .refine((d) => d.currentAuthKey || d.currentPassword, {
      message: "Current password is required",
      path: ["currentAuthKey"]
    })
    .refine((d) => d.currentAuthKey !== d.newAuthKey, {
      message: "New password must be different from the current password",
      path: ["newAuthKey"]
    })
});

const disable2FASchema = z.object({
  body: z
    .object({
      authKey: authKeySchema.optional(),
      password: legacyPassword.optional(),
      // A current code from the authenticator app, so a stolen session alone can't turn 2FA off
      code: z.string().trim().regex(/^d{6}$/, "Enter the 6-digit code from your authenticator app")
    })
    .strict()
    .refine((d) => d.authKey || d.password, { message: "Password is required", path: ["authKey"] })
});

module.exports = {
  passwordPolicy,
  keyBundleSchema,
  preloginSchema,
  loginSchema,
  disable2FASchema,
  verify2FASchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema
};
