const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const mongoSanitize = require("express-mongo-sanitize");
const hpp = require("hpp");
const morgan = require("morgan");
const compression = require("compression");

const config = require("./config/env");
const { apiLimiter } = require("./middlewares/rateLimiter.middleware");
const errorHandler = require("./middlewares/errorHandler.middleware");

// Routes
const authRoutes = require("./routes/auth.routes");
const customerAuthRoutes = require("./routes/customerAuth.routes");
const userRoutes = require("./routes/user.routes");
const taskRoutes = require("./routes/task.routes");
const commentRoutes = require("./routes/comment.routes");
const uploadRoutes = require("./routes/upload.routes");
const notificationRoutes = require("./routes/notification.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const chatRoutes = require("./routes/chat.routes");
const { campaignRoutes, catalogRoutes, adminContentRoutes } = require("./routes/content.routes");
const projectRoutes = require("./routes/project.routes");
const { slaRoutes, adminSlaRoutes, settingsRoutes } = require("./routes/sla.routes");
const { reportRoutes, ratingRoutes, adminReportRoutes } = require("./routes/report.routes");
const { moderationRoutes, adminModerationRoutes } = require("./routes/moderation.routes");
const phase8 = require("./routes/phase8.routes");
const phase9 = require("./routes/phase9.routes");
const phase10 = require("./routes/phase10.routes");

const app = express();

// Behind a reverse proxy / load balancer, set TRUST_PROXY_HOPS (usually 1) so req.ip is the real
// client address — per-IP rate limits and "new device" alerts depend on it.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 0));

// Security Headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://res.cloudinary.com", "https://*.s3.amazonaws.com"],
        connectSrc: ["'self'", config.clientUrl]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

// CORS
app.use(
  cors({
    origin: config.clientUrl,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
  })
);

// Gzip JSON responses over 1 KB (conversation and message lists shrink 5–10×).
// Safe against BREACH-style attacks here: auth tokens live only in cookies, never in bodies.
app.use(compression({ threshold: 1024 }));

// Logging
if (config.env !== "test") {
  // Coloured dev output is for local use; production gets a compact access log.
  app.use(morgan(config.env === "production" ? "combined" : "dev"));
}

// Request Parsers
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// Data Sanitization against NoSQL injection
app.use(mongoSanitize());

// Prevent HTTP Parameter Pollution
app.use(hpp());

// General API Rate Limiting
app.use("/api/v1", apiLimiter);
app.use("/api/v1", require("./middlewares/originCheck.middleware"));

// Health Check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// API Routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/campaigns", campaignRoutes);
app.use("/api/v1/catalog", catalogRoutes);
app.use("/api/v1/admin/projects", projectRoutes);
app.use("/api/v1/admin/sla", adminSlaRoutes);
app.use("/api/v1/admin/settings", settingsRoutes);
app.use("/api/v1/sla", slaRoutes);
app.use("/api/v1/admin/reports", adminReportRoutes);
app.use("/api/v1/admin/moderation", adminModerationRoutes);
app.use("/api/v1/admin/monitoring", require("./routes/monitoring.routes"));
app.use("/api/v1/admin/leads", phase8.adminLeadRoutes);
app.use("/api/v1/admin/testimonials", phase8.adminTestimonialRoutes);
app.use("/api/v1/projects", phase8.projectRoutes);
app.use("/api/v1/quick-replies", phase8.quickReplyRoutes);
app.use("/api/v1/testimonials", phase8.testimonialRoutes);
app.use("/api/v1/admin/privacy", phase9.adminPrivacyRoutes);
app.use("/api/v1/admin/payments", phase10.adminPaymentRoutes);
app.use("/api/v1/admin/referrals", phase10.adminReferralRoutes);
app.use("/api/v1/payments", phase10.paymentRoutes);
app.use("/api/v1/referrals", phase10.referralRoutes);
app.use("/api/v1/push", phase9.pushRoutes);
app.use("/api/v1/privacy", phase9.privacyRoutes);
app.use("/api/v1/moderation", moderationRoutes);
app.use("/api/v1/reports", reportRoutes);
app.use("/api/v1/ratings", ratingRoutes);
app.use("/api/v1/admin", adminContentRoutes);
app.use("/api/v1/customer/auth", customerAuthRoutes);
app.use("/api/v1/org", require("./routes/org.routes"));
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/tasks", taskRoutes);
app.use("/api/v1", commentRoutes);
app.use("/api/v1/uploads", uploadRoutes);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/dashboard", dashboardRoutes);
app.use("/api/v1/chat", chatRoutes);
app.use("/api/v1/chat", phase8.approvalRoutes); // design approvals (after the main chat routes)

// 404 Handler
app.use((req, res, next) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.originalUrl}` });
});

// Centralized Error Handler
app.use(errorHandler);

module.exports = app;
