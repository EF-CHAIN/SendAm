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
const authRoutes = require('./routes/auth.routes');
const receiptRoutes = require('./routes/receipt.routes');

const errorHandler = require('./middlewares/errorHandler');
const notFound = require('./middlewares/notFound');
const PostgresRateStore = require('./middlewares/postgresRateStore');
const config = require('./config/env');
const logger = require('./utils/logger');
const prisma = require('./common/prisma');
const { correlationMiddleware } = require('./observability/context');
const { requestMetrics, metricsHandler, increment } = require('./observability/metrics');
const { AppError } = require('./errors');
const { getContext } = require('./observability/context');

const app = express();

// Middlewares
app.use(correlationMiddleware);
app.use(requestMetrics);
// Security Middlewares
const cspDirectives = config.isProduction ? {
  defaultSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"]
} : {
  defaultSrc: ["'self'"],
  frameAncestors: ["'none'"],
};

app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// CORS: explicitly define origin allowlists by environment. 
// Cross-origin access strictly requires configuration.
const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. server-to-server, webhook)
    if (!origin) {
      return callback(null, true);
    }
    
    if (origin === 'null') {
      increment('sendam_cors_rejected_total', { reason: 'null_origin' });
      const err = new Error('CORS error: null origin not allowed');
      err.name = 'CorsError';
      return callback(err);
    }
    
    if (config.corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    increment('sendam_cors_rejected_total', { reason: 'unapproved_origin' });
    const err = new Error('Not allowed by CORS');
    err.name = 'CorsError';
    return callback(err);
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use((err, req, res, next) => {
  if (err.name === 'CorsError' || err.message.includes('CORS')) {
    logger.warn('CORS request rejected', { origin: req.headers.origin, error: err.message });
    return res.status(403).json({ success: false, message: err.message });
  }
  next(err);
});

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
  // 429s flow through the standard error envelope so clients get a stable
  // `rate_limited` code instead of the express-rate-limit default shape.
  handler: (_req, _res, next) => next(new AppError('rate_limited')),
});
app.use('/api/', limiter);

// Prometheus scrape endpoint. It is deliberately outside the API limiter so a
// traffic spike cannot blind monitoring, and protected by a dedicated token.
app.get('/metrics', metricsHandler);

// Health check for uptime monitors and platform probes. Not rate-limited and
// requires no auth; reports 503 if the database link is down.
app.get('/health', async (req, res) => {
  const correlationId = getContext().correlationId || null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    increment('sendam_health_checks_total', { status: 'ok' });
    res.status(200).json({ status: 'ok', db: 'connected', uptime: process.uptime(), correlationId });
  } catch (error) {
    increment('sendam_health_checks_total', { status: 'degraded' });
    logger.error('health_check_failed', error);
    res.status(503).json({ status: 'degraded', db: 'disconnected', uptime: process.uptime(), correlationId });
  }
});

const path = require('path');
const openapiSpecPath = path.join(__dirname, '../openapi.json');

app.get(['/api/docs/openapi.json', '/api/docs'], (req, res) => {
  res.sendFile(openapiSpecPath);
});

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/receipts', receiptRoutes);

// The REST wallet API requires a SEP-10 application session. The feature flag
// remains an operational rollout and incident-response kill switch.
if (config.features.walletRestApi) {
  if (config.isProduction) {
    logger.info('Authenticated REST wallet API enabled in production.');
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
