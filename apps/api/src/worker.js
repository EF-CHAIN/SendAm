const config = require('./config/env');
const connectDB = require('./config/db');
const { validateEnv, validateWorkerEnv } = require('./config/validateEnv');
const prisma = require('./common/prisma');
const logger = require('./utils/logger');
const { registerJobs } = require('./jobs');
const { closeQueues } = require('./queues/queue.service');

const startWorker = async ({
  jobs = registerJobs,
  connect = connectDB,
  disconnect = () => prisma.$disconnect(),
  closeQueueResources = closeQueues,
} = {}) => {
  validateEnv(config);
  validateWorkerEnv(config);
  await connect();
  const jobRuntime = await jobs();
  logger.info('worker_started', { env: config.env, processType: 'worker' });
  const heartbeat = setInterval(() => {
    logger.info('worker_heartbeat', { processType: 'worker' });
  }, config.worker.heartbeatIntervalMs);
  heartbeat.unref();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('worker_shutdown_started', { signal });
    const timeout = setTimeout(() => {
      logger.error('worker_shutdown_timeout', { signal });
      process.exit(1);
    }, config.worker.shutdownTimeoutMs);
    timeout.unref();

    try {
      clearInterval(heartbeat);
      await jobRuntime?.stop?.();
      await closeQueueResources();
      await disconnect();
      clearTimeout(timeout);
      logger.info('worker_stopped', { signal });
      return true;
    } catch (error) {
      clearTimeout(timeout);
      logger.error('worker_shutdown_failed', { signal, message: error.message });
      throw error;
    }
  };

  process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)).catch(() => process.exit(1)));
  process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)).catch(() => process.exit(1)));
  return { shutdown };
};

if (require.main === module) {
  startWorker().catch((error) => {
    logger.error('worker_start_failed', { message: error.message });
    process.exit(1);
  });
}

module.exports = { startWorker };
