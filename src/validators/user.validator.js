const { z } = require("zod");

const createUserSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters").max(100),
    email: z.string().email("Invalid email address"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[0-9]/, "Password must contain at least one number"),
    role: z.enum(["superadmin", "admin", "user"]).optional(),
    department: z.string().optional(),
    designation: z.string().optional()
  })
});

const updateUserSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(100).optional(),
    department: z.string().optional(),
    designation: z.string().optional(),
    avatarUrl: z.string().optional().nullable()
  })
});

const updateRoleSchema = z.object({
  body: z.object({
    role: z.enum(["superadmin", "admin", "user"], {
      required_error: "Role is required"
    })
  })
});

const updateStatusSchema = z.object({
  body: z.object({
    status: z.enum(["active", "inactive", "suspended"], {
      required_error: "Status is required"
    })
  })
});

module.exports = {
  createUserSchema,
  updateUserSchema,
  updateRoleSchema,
  updateStatusSchema
};
