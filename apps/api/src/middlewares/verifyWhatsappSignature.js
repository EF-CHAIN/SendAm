const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Verifies the X-Hub-Signature-256 header Meta attaches to every webhook POST.
 * Without this, anyone who knows the webhook URL could forge an event with any
 * `from` number and drive that user's wallet (including transfers).
 *
 * The signature is an HMAC-SHA256 of the RAW request body keyed with the Meta
 * App Secret, so we compare against req.rawBody (captured in app.js), not the
 * re-serialized JSON.
 *
 * Fail-closed in production: if WHATSAPP_APP_SECRET is unset there, every POST
 * is rejected. In development we allow unsigned requests (with a warning) so
 * local testing without the secret still works.
 */
const verifyWhatsappSignature = (req, res, next) => {
  if (!config.whatsapp.appSecret) {
    if (config.isProduction) {
      logger.error('WHATSAPP_APP_SECRET is not set in production — rejecting webhook POST.');
      return res.sendStatus(403);
    }
    logger.warn('WHATSAPP_APP_SECRET is not set; skipping signature check (development only).');
    return next();
  }

  const signature = req.get('X-Hub-Signature-256') || '';
  if (!signature.startsWith('sha256=') || !req.rawBody) {
    return res.sendStatus(403);
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', config.whatsapp.appSecret)
    .update(req.rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    logger.warn('Rejected webhook POST with invalid signature.');
    return res.sendStatus(403);
  }

  next();
};

module.exports = verifyWhatsappSignature;
