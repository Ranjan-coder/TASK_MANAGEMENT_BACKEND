const { z } = require("zod");
const { isOwnMedia } = require("../services/media.service");
const { normalizeIndianMobile } = require("../utils/phone");

const plainText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    // Plain text only: strip control characters (keep newlines/tabs)
    .transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""));

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const idParams = z.object({ id: objectId });

// ── Campaigns ─────────────────────────────────────────────────────────────────

const campaignMedia = z
  .object({
    url: z.string().max(1000),
    publicId: z.string().max(300),
    resourceType: z.enum(["image", "video"]),
    posterUrl: z.string().max(1000).nullable().optional(),
    width: z.number().int().positive().max(20000).optional(),
    height: z.number().int().positive().max(20000).optional(),
    duration: z.number().nonnegative().max(60.5).optional(),
    bytes: z.number().int().nonnegative().optional()
  })
  .strict()
  .refine((m) => isOwnMedia(m.url, m.publicId, "campaign") && (!m.posterUrl || isOwnMedia(m.posterUrl, m.publicId, "campaign")), {
    message: "Upload media through the campaign editor"
  });

const httpsUrl = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && v.length <= 500;
  } catch {
    return false;
  }
};

/**
 * CTA values are normalised so the page can only ever render safe links:
 * https URLs, tel: numbers, or wa.me links built from an Indian mobile number.
 */
const cta = z
  .object({
    type: z.enum(["none", "consultation", "call", "whatsapp", "link"]),
    label: plainText(30).optional().default(""),
    value: z.string().trim().max(500).optional().default("")
  })
  .strict()
  .transform((c, ctx) => {
    if (c.type === "none" || c.type === "consultation") return { ...c, value: "" };
    if (c.type === "link") {
      if (!httpsUrl(c.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Enter a full https:// link" });
        return z.NEVER;
      }
      return c;
    }
    if (c.type === "whatsapp") {
      const phone = normalizeIndianMobile(c.value);
      if (!phone) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Enter a 10-digit WhatsApp number" });
        return z.NEVER;
      }
      return { ...c, value: phone };
    }
    // call: Indian mobile or a landline/toll-free number
    const digits = c.value.replace(/[^\d+]/g, "");
    if (!/^\+?\d{6,15}$/.test(digits)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Enter a valid phone number" });
      return z.NEVER;
    }
    return { ...c, value: normalizeIndianMobile(digits) || digits };
  });

const campaignFields = {
  title: plainText(120).pipe(z.string().min(3, "Title must be at least 3 characters")),
  description: plainText(1000).optional().default(""),
  kind: z.enum(["video", "image", "offer"]),
  media: campaignMedia.nullable().optional(),
  offer: z
    .object({ badge: plainText(30).optional().default(""), terms: plainText(500).optional().default("") })
    .strict()
    .nullable()
    .optional(),
  cta: cta.optional().default({ type: "none", label: "", value: "" }),
  startAt: z.coerce.date(),
  endAt: z.coerce.date().nullable().optional(),
  priority: z.number().int().min(0).max(100).optional().default(50),
  status: z.enum(["draft", "published", "archived"]).optional().default("draft"),
  targetCities: z.array(plainText(50).pipe(z.string().min(2))).max(20).optional().default([])
};

const campaignRules = (c, ctx) => {
  if (c.endAt && c.endAt <= c.startAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endAt"], message: "End date must be after the start date" });
  }
  if (c.kind === "video" && c.media?.resourceType !== "video") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["media"], message: "Upload a video for a video campaign" });
  }
  if (c.kind === "image" && c.media?.resourceType !== "image") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["media"], message: "Upload an image or poster" });
  }
  if (c.kind === "offer" && c.media && c.media.resourceType !== "image") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["media"], message: "Offers can only have an image" });
  }
};

const createCampaignSchema = z.object({
  body: z.object(campaignFields).strict().superRefine(campaignRules)
});

const updateCampaignSchema = z.object({
  params: idParams,
  body: z.object(campaignFields).strict().superRefine(campaignRules)
});

const campaignEventSchema = z.object({
  params: idParams,
  body: z.object({ type: z.enum(["impression", "click"]) }).strict()
});

const leadSchema = z.object({
  params: idParams,
  body: z.object({ message: plainText(500).optional().default("") }).strict()
});

const liveCampaignsSchema = z.object({
  query: z.object({ city: plainText(50).optional() }).passthrough()
});

// ── Catalog ───────────────────────────────────────────────────────────────────

const catalogImage = z
  .object({
    url: z.string().max(1000),
    publicId: z.string().max(300),
    width: z.number().int().positive().max(20000).optional(),
    height: z.number().int().positive().max(20000).optional()
  })
  .strict()
  .refine((i) => isOwnMedia(i.url, i.publicId, "catalog"), { message: "Upload images through the catalog editor" });

const catalogFields = {
  kind: z.enum(["product", "service", "portfolio"]),
  category: plainText(50).pipe(z.string().min(2, "Choose a category")),
  name: plainText(120).pipe(z.string().min(2, "Name must be at least 2 characters")),
  summary: plainText(200).optional().default(""),
  description: plainText(3000).optional().default(""),
  images: z.array(catalogImage).max(8).optional().default([]),
  beforeImage: catalogImage.nullable().optional(),
  location: plainText(60).optional().default(""),
  startingPrice: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  priceUnit: plainText(30).optional().default(""),
  features: z.array(plainText(80).pipe(z.string().min(1))).max(12).optional().default([]),
  order: z.number().int().min(0).max(10000).optional().default(0),
  featured: z.boolean().optional().default(false),
  isPublished: z.boolean().optional().default(false)
};

const createCatalogSchema = z.object({ body: z.object(catalogFields).strict() });
const updateCatalogSchema = z.object({ params: idParams, body: z.object(catalogFields).strict() });

const catalogListSchema = z.object({
  query: z
    .object({
      kind: z.enum(["product", "service", "portfolio"]).optional(),
      category: plainText(50).optional()
    })
    .passthrough()
});

const slugParams = z.object({
  params: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,140}$/, "Invalid link") })
});

module.exports = {
  idParamsSchema: z.object({ params: idParams }),
  createCampaignSchema,
  updateCampaignSchema,
  campaignEventSchema,
  leadSchema,
  liveCampaignsSchema,
  createCatalogSchema,
  updateCatalogSchema,
  catalogListSchema,
  slugParams
};
