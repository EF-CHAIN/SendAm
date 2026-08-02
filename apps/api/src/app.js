const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const webhookRoutes = require('./routes/webhook.routes');
const walletRoutes = require('./routes/wallet.routes');
const adminRoutes = require('./routes/admin.routes');
const complianceRoutes = require('./compliance/compliance.routes');
const pricingRoutes = require('./pricing/pricing.routes');
const simRoutes = require('./routes/sim.routes');

const errorHandler = require('./middlewares/errorHandler');
const notFound = require('./middlewares/notFound');
const PostgresRateStore = require('./middlewares/postgresRateStore');
const config = require('./config/env');
const logger = require('./utils/logger');
const prisma = require('./common/prisma');
const { correlationMiddleware } = require('./observability/context');
const { requestMetrics, metricsHandler, increment } = require('./observability/metrics');

const app = express();

// Middlewares
app.use(correlationMiddleware);
app.use(requestMetrics);
app.use(helmet());

// CORS: in production only the configured origins may call the API. Outside
// production we fall back to open CORS for convenience, but warn if no
// allowlist is set so it isn't forgotten before launch.
if (config.corsOrigins.length > 0) {
  app.use(cors({ origin: config.corsOrigins }));
} else {
  if (config.isProduction) {
    logger.error('CORS_ORIGINS is not set in production — refusing all cross-origin requests.');
  } else {
    logger.warn('CORS_ORIGINS is not set; allowing all origins (development only).');
  }
  app.use(cors({ origin: config.isProduction ? false : true }));
}

// Access logs: the verbose, colorized 'dev' format is great locally but unfit
// for production log aggregation. Use the standard Apache 'combined' format in
// production so hosted log drains get parseable, complete request lines.
if (!config.isProduction) app.use(morgan('dev'));
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => logger.info('http_request_completed', {
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    durationMs: Number(process.hrtime.bigint() - started) / 1e6,
  }));
  next();
});

// Capture the raw request body so the WhatsApp webhook can verify the
// X-Hub-Signature-256 HMAC against exactly what Meta signed.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting (REST). PostgreSQL-backed store so the per-IP window is shared
// across instances. The WhatsApp webhook is throttled separately, per sender,
// in its controller — Meta proxies all events through a few IPs, so an IP
// limiter there would throttle every user together.
const limiter = rateLimit({
  windowMs: config.rateLimit.apiWindowMs,
  max: config.rateLimit.apiMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateStore(),
});
app.use('/api/', limiter);

// Prometheus scrape endpoint. It is deliberately outside the API limiter so a
// traffic spike cannot blind monitoring, and protected by a dedicated token.
app.get('/metrics', metricsHandler);

// Health check for uptime monitors and platform probes. Not rate-limited and
// requires no auth; reports 503 if the database link is down.
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    increment('sendam_health_checks_total', { status: 'ok' });
    res.status(200).json({ status: 'ok', db: 'connected', uptime: process.uptime() });
  } catch (error) {
    increment('sendam_health_checks_total', { status: 'degraded' });
    logger.error('health_check_failed', error);
    res.status(503).json({ status: 'degraded', db: 'disconnected', uptime: process.uptime() });
  }
});

// Routes
app.use('/webhook', webhookRoutes);

// The REST wallet API is unauthenticated (phone number in the body is the only
// "identity"), so it's gated off in production by default. WhatsApp is the real
// surface; see config.features.walletRestApi.
if (config.features.walletRestApi) {
  if (config.isProduction) {
    logger.warn('ENABLE_WALLET_REST_API=true in production — the unauthenticated /api/wallet routes are exposed.');
  }
  app.use('/api/wallet', walletRoutes);
} else {
  logger.info('REST wallet API (/api/wallet) is disabled. Set ENABLE_WALLET_REST_API=true to enable.');
}

app.use('/api/admin', adminRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/pricing', pricingRoutes);

// The chat simulator (/api/sim/*) is an unauthenticated dev/test harness and
// must not be reachable in production by accident. Gated by ENABLE_CHAT_SIM,
// defaulting off in production — same pattern as the REST wallet API above.
if (config.features.chatSim) {
  if (config.isProduction) {
    logger.warn('ENABLE_CHAT_SIM=true in production — the unauthenticated /api/sim routes are exposed.');
  }
  app.use('/api/sim', simRoutes);
} else {
  logger.info('Chat simulator (/api/sim) is disabled. Set ENABLE_CHAT_SIM=true to enable.');
}

// Error Handling
app.use(notFound);
app.use(errorHandler);

module.exports = app;
