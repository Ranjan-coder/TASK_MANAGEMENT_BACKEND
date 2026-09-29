const dns = require("dns");
const mongoose = require("mongoose");
const config = require("./env");
const logger = require("../utils/logger");

// Force Node.js to use Google DNS to resolve MongoDB Atlas SRV records.
// The default local/router DNS often cannot resolve _mongodb._tcp SRV entries.
// Only outside production: in a VPC the platform resolver must be used, and this
// setting applies to every lookup in the process (SMTP, MSG91, Cloudinary …).
dns.setDefaultResultOrder("ipv4first");
if (config.env !== "production") dns.setServers(["8.8.8.8", "8.8.4.4"]);

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(config.mongoUri, {
      autoIndex: config.env !== "production",
      maxPoolSize: 20,
      // Fail fast during an outage instead of hanging each request for 30 s.
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000
    });
    logger.info(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    logger.error(`MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected. Attempting reconnection...");
});

module.exports = connectDB;
