const { z } = require("zod");
const { authKeySchema, saltSchema } = require("../utils/kdf");
const { normalizeIndianMobile } = require("../utils/phone");
const { organisationCode } = require("./auth.validator");

const indianMobile = z
  .string({ required_error: "Mobile number is required" })
  .transform((value, ctx) => {
    const phone = normalizeIndianMobile(value);
    if (!phone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid 10-digit Indian mobile number" });
      return z.NEVER;
    }
    return phone;
  });

const otpCode = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");
const stepToken = z.string().min(20, "Verification session missing").max(2048);

// `.strict()` everywhere: unknown fields are rejected. There is no public sign-up:
// customers are added by their organisation (module-access-plan.md, M2).
const sendVerificationOtpSchema = z.object({
  body: z.object({ verificationToken: stepToken, phone: indianMobile.optional() }).strict()
});

const verifyPhoneSchema = z.object({
  body: z.object({ verificationToken: stepToken, code: otpCode }).strict()
});

const passwordResetOtpSchema = z.object({
  body: z.object({ phone: indianMobile }).strict()
});

// Either phone + code, or (after choosing an organisation) the reset token from the first step
const passwordResetWithOtpSchema = z.object({
  body: z
    .object({
      phone: indianMobile.optional(),
      code: otpCode.optional(),
      resetToken: stepToken.optional(),
      organisation: organisationCode,
      authKey: authKeySchema,
      kdfSalt: saltSchema
    })
    .strict()
    .refine((d) => d.resetToken || (d.phone && d.code), { message: "Enter your mobile number and the 6-digit code", path: ["code"] })
});

module.exports = {
  sendVerificationOtpSchema,
  verifyPhoneSchema,
  passwordResetOtpSchema,
  passwordResetWithOtpSchema
};
