const { z } = require("zod");
const { authKeySchema, saltSchema } = require("../utils/kdf");
const { normalizeIndianMobile } = require("../utils/phone");

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

// `.strict()` everywhere: unknown fields (role, status, ...) are rejected.
const customerRegisterSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
      email: z.string().trim().toLowerCase().email("Invalid email address").max(254),
      phone: indianMobile,
      // Password is never sent: the browser derives authKey from it (see utils/kdf.js)
      authKey: authKeySchema,
      kdfSalt: saltSchema,
      acceptTerms: z.literal(true, {
        errorMap: () => ({ message: "Please accept the Terms and Privacy Policy" })
      }),
      // Separate, optional consent: WhatsApp alerts when the designer replies
      projectAlerts: z.boolean().optional().default(false),
      // Optional friend's referral code (checked server-side, never blocks signup)
      referralCode: z.string().trim().max(20).regex(/^[A-Za-z0-9-]*$/, "Invalid referral code").optional()
    })
    .strict()
});

const sendVerificationOtpSchema = z.object({
  body: z.object({ verificationToken: stepToken, phone: indianMobile.optional() }).strict()
});

const verifyPhoneSchema = z.object({
  body: z.object({ verificationToken: stepToken, code: otpCode }).strict()
});

const passwordResetOtpSchema = z.object({
  body: z.object({ phone: indianMobile }).strict()
});

const passwordResetWithOtpSchema = z.object({
  body: z.object({ phone: indianMobile, code: otpCode, authKey: authKeySchema, kdfSalt: saltSchema }).strict()
});

module.exports = {
  customerRegisterSchema,
  sendVerificationOtpSchema,
  verifyPhoneSchema,
  passwordResetOtpSchema,
  passwordResetWithOtpSchema
};
