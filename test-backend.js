/**
 * Backend Sanity Check & Verification Script
 * Validates that all models, services, controllers, routes, jobs, and middlewares load without error.
 */

console.log("=== Starting Backend Module Verification ===");

try {
  console.log("1. Loading Config...");
  const config = require("./src/config/env");
  console.log("   -> Config loaded successfully (Port: " + config.port + ")");

  console.log("2. Loading Models...");
  const User = require("./src/models/User");
  const Task = require("./src/models/Task");
  const Comment = require("./src/models/Comment");
  const Attachment = require("./src/models/Attachment");
  const Notification = require("./src/models/Notification");
  const AuditLog = require("./src/models/AuditLog");
  console.log("   -> All 6 Mongoose models loaded successfully");

  console.log("3. Loading Middlewares...");
  require("./src/middlewares/auth.middleware");
  require("./src/middlewares/rbac.middleware");
  require("./src/middlewares/verifyAccess.middleware");
  require("./src/middlewares/validate.middleware");
  require("./src/middlewares/rateLimiter.middleware");
  require("./src/middlewares/upload.middleware");
  require("./src/middlewares/errorHandler.middleware");
  console.log("   -> All 7 middlewares loaded successfully");

  console.log("4. Loading Validators...");
  require("./src/validators/auth.validator");
  require("./src/validators/task.validator");
  require("./src/validators/user.validator");
  require("./src/validators/comment.validator");
  require("./src/validators/upload.validator");
  console.log("   -> All 5 validator schemas loaded successfully");

  console.log("5. Loading Services...");
  require("./src/services/auth.service");
  require("./src/services/twoFactor.service");
  require("./src/services/task.service");
  require("./src/services/email.service");
  require("./src/services/notification.service");
  require("./src/services/audit.service");
  console.log("   -> All 6 services loaded successfully");

  console.log("6. Loading Controllers...");
  require("./src/controllers/auth.controller");
  require("./src/controllers/user.controller");
  require("./src/controllers/task.controller");
  require("./src/controllers/comment.controller");
  require("./src/controllers/upload.controller");
  require("./src/controllers/notification.controller");
  require("./src/controllers/dashboard.controller");
  console.log("   -> All 7 controllers loaded successfully");

  console.log("7. Loading Routes...");
  require("./src/routes/auth.routes");
  require("./src/routes/user.routes");
  require("./src/routes/task.routes");
  require("./src/routes/comment.routes");
  require("./src/routes/upload.routes");
  require("./src/routes/notification.routes");
  require("./src/routes/dashboard.routes");
  console.log("   -> All 7 route files loaded successfully");

  console.log("8. Loading Express App...");
  const app = require("./src/app");
  console.log("   -> Express app initialized successfully");

  console.log("9. Loading Sockets...");
  const { initSockets } = require("./src/sockets");
  console.log("   -> Sockets module initialized successfully");

  console.log("\n✅ ALL BACKEND MODULES AND SCHEMAS VERIFIED SUCCESSFULLY!");
  process.exit(0);
} catch (error) {
  console.error("\n❌ Backend verification failed with error:", error);
  process.exit(1);
}
