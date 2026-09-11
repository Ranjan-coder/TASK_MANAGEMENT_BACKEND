const config = require("../config/env");
const logger = require("../utils/logger");

const errorHandler = (err, req, res, next) => {
  let { statusCode = 500, message = "Internal Server Error", errors = [] } = err;

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
      body: req.body,
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
