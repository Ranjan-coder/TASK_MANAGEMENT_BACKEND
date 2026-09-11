const { z } = require("zod");

const isDateNotBeforeToday = (dateStr) => {
  if (!dateStr) return true;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
};

const isDueDateValid = (data) => {
  if (!data.dueDate) return true;
  const due = new Date(data.dueDate);
  if (isNaN(due.getTime())) return true;

  if (data.startDate) {
    const start = new Date(data.startDate);
    if (!isNaN(start.getTime())) {
      return due >= start;
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due >= today;
};

const createTaskSchema = z.object({
  body: z
    .object({
      title: z.string().min(3, "Title must be at least 3 characters").max(200),
      description: z.string().optional(),
      priority: z.enum(["low", "medium", "high", "critical"]).optional(),
      assignedTo: z.array(z.string()).optional(),
      dueDate: z.string().optional().nullable(),
      startDate: z.string().optional().nullable(),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      watchers: z.array(z.string()).optional(),
      parentTask: z.string().optional().nullable()
    })
    .refine((data) => isDateNotBeforeToday(data.startDate), {
      message: "Start date cannot be earlier than today's date",
      path: ["startDate"]
    })
    .refine((data) => isDueDateValid(data), {
      message: "Due date cannot be earlier than start date",
      path: ["dueDate"]
    })
});

const updateTaskSchema = z.object({
  body: z
    .object({
      title: z.string().min(3).max(200).optional(),
      description: z.string().optional(),
      priority: z.enum(["low", "medium", "high", "critical"]).optional(),
      assignedTo: z.array(z.string()).optional(),
      dueDate: z.string().optional().nullable(),
      startDate: z.string().optional().nullable(),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      watchers: z.array(z.string()).optional()
    })
    .refine((data) => isDueDateValid(data), {
      message: "Due date cannot be earlier than start date",
      path: ["dueDate"]
    })
});

const updateStatusSchema = z.object({
  body: z.object({
    status: z.enum(["todo", "in_progress", "in_review", "completed", "blocked", "cancelled"])
  })
});

const addCommentSchema = z.object({
  body: z.object({
    text: z.string().min(1, "Comment text cannot be empty"),
    mentions: z.array(z.string()).optional(),
    attachments: z.array(z.string()).optional()
  })
});

module.exports = {
  createTaskSchema,
  updateTaskSchema,
  updateStatusSchema,
  addCommentSchema
};
