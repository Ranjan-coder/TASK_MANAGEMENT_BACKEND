const { z } = require("zod");

const addCommentSchema = z.object({
  body: z.object({
    text: z
      .string()
      .min(1, "Comment text cannot be empty")
      .max(5000, "Comment cannot exceed 5000 characters"),
    mentions: z.array(z.string()).optional().default([]),
    attachments: z.array(z.string()).optional().default([])
  })
});

const updateCommentSchema = z.object({
  body: z.object({
    text: z
      .string()
      .min(1, "Comment text cannot be empty")
      .max(5000, "Comment cannot exceed 5000 characters")
  })
});

module.exports = {
  addCommentSchema,
  updateCommentSchema
};
