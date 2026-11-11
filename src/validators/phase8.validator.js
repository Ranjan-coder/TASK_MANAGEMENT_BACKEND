const { z } = require("zod");
const { isOwnMedia } = require("../services/media.service");

const id = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const text = (min, max) =>
  z
    .string()
    .transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .pipe(z.string().min(min).max(max));

// Stage and step keys come from each company's workflow (modules/workflows)
const stageKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "Unknown stage");
const stepKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}(\/[a-z][a-z0-9_]{1,39})?$/, "Unknown step");

const stageSchema = z.object({
  params: z.object({ id }),
  body: z
    .object({
      stage: stageKey,
      // The stage the person was looking at (stops two people moving it at once)
      from: stageKey.optional(),
      note: text(0, 300).optional().default(""),
      expectedHandover: z.coerce.date().nullable().optional()
    })
    .strict()
});

// ── Workflow steps (project-workflow-plan.md §8) ──
const stepMoveSchema = z.object({
  params: z.object({ id }),
  body: z
    .object({
      to: stepKey,
      from: stepKey, // required: the step on screen
      note: text(0, 300).optional().default(""),
      override: z.boolean().optional().default(false)
    })
    .strict()
});
const stepPathSchema = z.object({
  params: z.object({ id }),
  body: z.object({ path: stepKey, note: text(0, 300).optional().default("") }).strict()
});
const tickSchema = z.object({ params: z.object({ id }), body: z.object({ path: stepKey, done: z.boolean() }).strict() });
const extraAddSchema = z.object({ params: z.object({ id }), body: z.object({ stageKey, note: text(5, 300) }).strict() });
const extraUpdateSchema = z.object({ params: z.object({ id, extraId: id }), body: z.object({ action: z.enum(["done", "remove"]) }).strict() });
const checklistSchema = z.object({ params: z.object({ id }), body: z.object({ itemKey: stageKey, done: z.boolean() }).strict() });

const requestApprovalSchema = z.object({ params: z.object({ id }), body: z.object({ messageId: id, title: text(2, 100) }).strict() });
const decideApprovalSchema = z.object({
  params: z.object({ id }),
  body: z.object({ decision: z.enum(["approved", "changes_requested"]), comment: text(0, 1000).optional().default("") }).strict()
});
const idParams = z.object({ params: z.object({ id }) });

const quickReplyBody = { title: text(1, 60), text: text(1, 1000) };
const createQuickReplySchema = z.object({ body: z.object({ ...quickReplyBody, shared: z.boolean().optional().default(false) }).strict() });
const updateQuickReplySchema = z.object({
  params: z.object({ id }),
  body: z.object(quickReplyBody).partial().strict().refine((b) => Object.keys(b).length > 0, "Nothing to update")
});

const LEAD_STATUSES = ["new", "contacted", "converted", "closed"];
const leadListSchema = z.object({
  query: z
    .object({
      status: z.enum(LEAD_STATUSES).optional(),
      campaign: id.optional(),
      search: z.string().trim().max(80).optional(),
      page: z.coerce.number().int().min(1).max(1000).optional().default(1)
    })
    .strict()
});
const leadUpdateSchema = z.object({
  params: z.object({ id }),
  body: z
    .object({ status: z.enum(LEAD_STATUSES).optional(), note: text(1, 1000).optional(), assignToMe: z.literal(true).optional() })
    .strict()
    .refine((b) => Object.keys(b).length > 0, "Nothing to update")
});

const photo = z
  .object({ url: z.string().max(1000), publicId: z.string().max(300) })
  .strict()
  .refine((p) => isOwnMedia(p.url, p.publicId, "catalog"), { message: "Upload the photo through the editor" });

const testimonialBody = {
  customerName: text(2, 60),
  location: text(0, 60).optional().default(""),
  quote: text(10, 600),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  projectType: text(0, 60).optional().default(""),
  photo: photo.nullable().optional(),
  portfolioItem: id.nullable().optional(),
  consentConfirmed: z.literal(true, { errorMap: () => ({ message: "Confirm the customer agreed to be quoted" }) }),
  isPublished: z.boolean().optional().default(false),
  order: z.number().int().min(0).max(10000).optional().default(0)
};
const createTestimonialSchema = z.object({ body: z.object(testimonialBody).strict() });
const updateTestimonialSchema = z.object({ params: z.object({ id }), body: z.object(testimonialBody).strict() });

// ── Project contacts (project-contacts-plan.md) ──
const { CONTACT_TOPICS, MAX_CONTACTS } = require("../models/subschemas/projectContact");
const { normalizeIndianMobile } = require("../utils/phone");

const contactItem = z
  .object({
    topic: z.enum(CONTACT_TOPICS),
    label: text(0, 40).optional().default(""),
    user: id,
    phone: z.string().trim().max(20).optional().default(""),
    whatsapp: z.boolean().optional().default(false),
    email: z.string().trim().toLowerCase().max(120).optional().default(""),
    hours: text(0, 60).optional().default("")
  })
  .strict()
  .transform((c, ctx) => {
    if (c.topic === "custom" && c.label.length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["label"], message: "Name the topic (e.g. Furniture delivery)" });
    }
    let phone = "";
    if (c.phone) {
      // Indian mobiles are stored as +91…; landlines / toll-free as digits
      const digits = c.phone.replace(/[^\d+]/g, "");
      phone = normalizeIndianMobile(c.phone) || (/^\+?\d{6,15}$/.test(digits) ? digits : "");
      if (!phone) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["phone"], message: "Enter a valid phone number" });
    }
    if (c.whatsapp && !(phone && normalizeIndianMobile(phone))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["whatsapp"], message: "WhatsApp needs a 10-digit mobile number" });
    }
    if (c.email && !z.string().email().safeParse(c.email).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "Enter a valid email" });
    }
    return { ...c, phone, whatsapp: Boolean(c.whatsapp && phone) };
  });

const contactsBody = z
  .object({
    contacts: z.array(contactItem).max(MAX_CONTACTS, `Up to ${MAX_CONTACTS} contacts`),
    // The revision the editor started from (two editors can't overwrite each other)
    rev: z.number().int().min(0)
  })
  .strict();

const projectContactsSchema = z.object({ params: z.object({ id }), body: contactsBody });
const companyContactsSchema = z.object({ body: contactsBody });
const candidatesQuery = z.object({ search: text(0, 60).optional() }).strict();
// One per route: the company list has no :id (Express passes params as {}, not undefined)
const contactCandidatesSchema = z.object({ params: z.object({ id }), query: candidatesQuery });
const companyCandidatesSchema = z.object({ query: candidatesQuery });

module.exports = {
  projectContactsSchema,
  companyContactsSchema,
  contactCandidatesSchema,
  companyCandidatesSchema,
  stageSchema,
  stepMoveSchema,
  stepPathSchema,
  tickSchema,
  extraAddSchema,
  extraUpdateSchema,
  checklistSchema,
  requestApprovalSchema,
  decideApprovalSchema,
  idParams,
  createQuickReplySchema,
  updateQuickReplySchema,
  leadListSchema,
  leadUpdateSchema,
  createTestimonialSchema,
  updateTestimonialSchema
};
