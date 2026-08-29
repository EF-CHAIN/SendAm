const { initializeErrorMonitoring, captureException } = require('./observability/errors');
initializeErrorMonitoring();

const http = require('http');
const https = require('https');
const app = require('./app');
const config = require('./config/env');
const connectDB = require('./config/db');
const { validateEnv } = require('./config/validateEnv');
const prisma = require('./common/prisma');
const logger = require('./utils/logger');
const { closeQueues } = require('./queues/queue.service');

// Configure upstream timeouts for all outgoing HTTP(S+) requests.
http.globalAgent = new http.Agent({ timeout: 15000 });
https.globalAgent = new https.Agent({ timeout: 15000 });

// Body size limits (bytes) by route type. Webhook/media flows get larger limits.
const MAX_BODY_DEFAULT = 1 * 1024 * 1024; // 1 MB
const MAX_BODY_WEBHOOK = 10 * 1024 * 1024; // 10 MB
const MAX_BODY_MEDIA = 25 * 1024 * 1024; // 25 MB

function getMaxBodyBytes(url) {
  if (/\/webhooks?(\/|$)/i.test(url)) return MAX_BODY_WEBHOOK;
  if (/\/media\/|\/uploads?\/|\/files?\/|\/attachments?(\/|$)/i.test(url)) return MAX_BODY_MEDIA;
  return MAX_BODY_DEFAULT;
}

function isBodyTooLarge(req) {
  const contentLength = Number(req.headers['content-length']);
  if (!Number.isFinite(contentLength) || contentLength <= 0) return false;
  return contentLength > getMaxBodyBytes(req.url);
}

const startServer = async () => {
  validateEnv(config);
  await connectDB();

  const server = http.createServer((req, res) => {
    if (isBodyTooLarge(req)) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large' }));
      logger.warn('payload_too_large', {
        method: req.method,
        url: req.url,
        contentLength: req.headers['content-length'],
      });
      return;
    }
    app(req, res);
  });

  // Terminate stalled requests predictably.
  server.headersTimeout = 31 * 1000;
  server.requestTimeout = 30 * 1000;
  server.timeout = 30 * 1000;
  server.keepAliveTimeout = 5 * 1000;

  server.listen(config.port, () => {
    app.markStartupComplete();
    logger.info('api_started', { environment: config.env, port: config.port });
  });

  // Graceful shutdown: stop accepting new connections, let in-flight requests
  // finish, close the DB link, then exit. A payment can be mid-submit on
  // deploy/restart, so we drain instead of hard-killing the process.
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully.`);
    server.close(async () => {
      try {
        await closeQueues();
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
  process.on('SIGNIT', () => shutdown('SIGINT'));
};

startServer().catch(async (error) => {
  logger.error('api_start_failed', error);
  await captureException(error, { source: 'api_startup' });
  process.exit(1);
});