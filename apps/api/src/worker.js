const config = require('./config/env');
const connectDB = require('./config/db');
const { validateEnv, validateWorkerEnv } = require('./config/validateEnv');
const prisma = require('./common/prisma');
const logger = require('./utils/logger');
const { registerJobs } = require('./jobs');
const {
  closeQueues, getQueueReadiness, getRegisteredProcessors, collectQueueMetrics,
} = require('./queues/queue.service');
const { cancelInFlightSends } = require('./services/whatsapp.service');
const { createWorkerHealth, startWorkerHealthServer } = require('./observability/workerHealth');

const startWorker = async ({
  jobs = registerJobs,
  connect = connectDB,
  disconnect = () => prisma.$disconnect(),
  closeQueueResources = closeQueues,
  createHealth = createWorkerHealth,
  startHealthServer = startWorkerHealthServer,
} = {}) => {
  validateEnv(config);
  validateWorkerEnv(config);
  await connect();
  const jobRuntime = await jobs();
  const health = createHealth({
    checkDatabase: () => prisma.$queryRawUnsafe('SELECT 1'),
    checkRedis: getQueueReadiness,
    getProcessors: getRegisteredProcessors,
    expectedProcessors: jobRuntime?.processorNames || ['whatsapp-inbound'],
    heartbeatFreshnessMs: config.worker.heartbeatFreshnessMs,
  });
  const healthRuntime = await startHealthServer({
    health,
    collectMetrics: collectQueueMetrics,
    port: config.worker.healthPort,
    metricsIntervalMs: config.worker.metricsIntervalMs,
  });
  logger.info('worker_started', { env: config.env, processType: 'worker' });
  const heartbeat = setInterval(() => {
    health.beat();
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
      health.markShuttingDown();
      cancelInFlightSends(`worker shutdown: ${signal}`);
      await healthRuntime.close();
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
  return { shutdown, health };
};

if (require.main === module) {
  startWorker().catch((error) => {
    logger.error('worker_start_failed', { message: error.message });
    process.exit(1);
  });
}

module.exports = { startWorker };
