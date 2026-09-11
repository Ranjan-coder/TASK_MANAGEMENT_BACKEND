const http = require("http");
const app = require("./app");
const config = require("./config/env");
const connectDB = require("./config/db");
const { initSockets } = require("./sockets");
const logger = require("./utils/logger");

// Initialize background job workers (non-blocking)
require("./jobs/emailWorker");
require("./jobs/dueDateReminder.job");

const startServer = async () => {
  // Connect to Database
  await connectDB();

  const server = http.createServer(app);

  // Initialize Socket.io
  initSockets(server);

  server.listen(config.port, () => {
    logger.info(`Server running in ${config.env} mode on port ${config.port}`);
    logger.info(`REST API Base: http://localhost:${config.port}/api/v1`);
  });

  // Graceful Shutdown
  const shutdown = () => {
    logger.info("Received kill signal, shutting down gracefully...");
    server.close(() => {
      logger.info("Closed out remaining connections.");
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("Could not close connections in time, forcefully shutting down");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

startServer();
