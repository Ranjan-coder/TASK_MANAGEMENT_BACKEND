const { z } = require("zod");

const attachLinkSchema = z.object({
  body: z.object({
    url: z.string().url("Invalid URL format"),
    title: z.string().max(200).optional(),
    entityType: z.enum(["task", "comment"], {
      required_error: "entityType must be 'task' or 'comment'"
    }),
    entityId: z.string().min(1, "entityId is required")
  })
});

const uploadFileSchema = z.object({
  body: z.object({
    entityType: z.enum(["task", "comment"], {
      required_error: "entityType must be 'task' or 'comment'"
    }),
    entityId: z.string().min(1, "entityId is required")
  })
});

module.exports = {
  attachLinkSchema,
  uploadFileSchema
};
