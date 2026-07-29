const app = require('./app');
const config = require('./config/env');
const connectDB = require('./config/db');
const { validateEnv } = require('./config/validateEnv');
const prisma = require('./common/prisma');
const logger = require('./utils/logger');
const { registerJobs } = require('./jobs');
const { stopPoller } = require('./jobs/poller');

const startServer = async () => {
  validateEnv(config);
  await connectDB();
  registerJobs();

  const server = app.listen(config.port, () => {
    logger.info(`Server running in ${config.env} mode on port ${config.port}`);
  });

  // Graceful shutdown: stop accepting new connections, let in-flight requests
  // finish, close the DB link, then exit. A payment can be mid-submit on
  // deploy/restart, so we drain instead of hard-killing the process.
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully.`);
    // Stop the poller before the DB link closes so a tick can't fire mid-drain.
    stopPoller();

    server.close(async () => {
      try {
        await prisma.$disconnect();
      } catch (error) {
        logger.error('Error closing PostgreSQL connection:', error.message);
      }
      process.exit(0);
    });

    // Backstop: if draining hangs, force exit rather than block the platform.
    setTimeout(() => {
      logger.error('Could not drain in time — forcing shutdown.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

startServer();
