const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const webhookRoutes = require('./routes/webhook.routes');
const walletRoutes = require('./routes/wallet.routes');
const adminRoutes = require('./routes/admin.routes');
const escrowRoutes = require('./escrow/escrow.routes');
const complianceRoutes = require('./compliance/compliance.routes');
const pricingRoutes = require('./pricing/pricing.routes');

const errorHandler = require('./middlewares/errorHandler');
const notFound = require('./middlewares/notFound');
const PostgresRateStore = require('./middlewares/postgresRateStore');
const config = require('./config/env');
const logger = require('./utils/logger');

const app = express();

// Middlewares
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

app.use(morgan('dev'));

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

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/escrow', escrowRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/pricing', pricingRoutes);

// Error Handling
app.use(notFound);
app.use(errorHandler);

module.exports = app;
