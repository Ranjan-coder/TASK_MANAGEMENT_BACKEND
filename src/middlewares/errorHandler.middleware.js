const config = require("../config/env");
const logger = require("../utils/logger");

// Never write secrets to logs (passwords, derived keys, OTPs, encrypted key material)
const SENSITIVE_KEYS = /pass(word)?|authkey|token|secret|code|otp|keybundle|recovery|ciphertext|wrapped|iv$/i;
const redact = (value, depth = 0) => {
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1)])
  );
};

const errorHandler = (err, req, res, next) => {
  let { statusCode = 500, message = "Internal Server Error", errors = [] } = err;

  // Upload errors from multer (file too large, too many files, ...)
  if (err.name === "MulterError") {
    statusCode = 400;
    message = err.code === "LIMIT_FILE_SIZE" ? "That file is too large." : "Upload failed. Send one file at a time.";
  }

  // Handle Mongoose Bad ObjectId
  if (err.name === "CastError") {
    statusCode = 400;
    message = `Resource not found with id of ${err.value}`;
  }

  // Handle Mongoose Duplicate Key
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue)[0];
    message = `Duplicate value entered for ${field} field`;
  }

  // Handle Mongoose Validation Error
  if (err.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((val) => val.message)
      .join(", ");
  }

  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, {
      stack: err.stack,
      body: redact(req.body),
      user: req.user?._id
    });
  } else {
    logger.warn(`${req.method} ${req.originalUrl} - [${statusCode}] ${message}`);
  }

  res.status(statusCode).json({
    success: false,
    message,
    errors,
    ...(config.env === "development" && { stack: err.stack })
  });
};

module.exports = errorHandler;
