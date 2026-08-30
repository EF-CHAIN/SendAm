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
 *
 * This supports rotating Meta App Secrets by checking both active and previous
 * secrets configured in WHATSAPP_APP_SECRET as comma-separated values.
 */
const verifyWhatsappSignature = (req, res, next) => {
  if (!config.whatsapp.appSecrets || config.whatsapp.appSecrets.length === 0) {
    if (config.isProduction) {
      logger.error('WHATSAPP_APP_SECRET is not set in production — rejecting webhook POST.');
      return res.sendStatus(403);
    }
    logger.warn('WHATSAPP_APP_SECRET is not set; skipping signature check (development only).');
    return next();
  }

  const signature = req.get('X-Hub-Signature-256') || '';
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature) || !Buffer.isBuffer(req.rawBody)) {
    logger.warn('whatsapp_webhook_signature_rejected', { reason: 'missing_or_malformed' });
    return res.sendStatus(403);
  }

  let matchedIdx = -1;
  const sigBuf = Buffer.from(signature);

  for (let i = 0; i < config.whatsapp.appSecrets.length; i++) {
    const secret = config.whatsapp.appSecrets[i];
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(req.rawBody)
      .digest('hex');

    const expBuf = Buffer.from(expected);
    if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
      matchedIdx = i;
      break;
    }
  }

  if (matchedIdx === -1) {
    logger.warn('whatsapp_webhook_signature_rejected', { reason: 'mismatch' });
    return res.sendStatus(403);
  }

  const secretType = matchedIdx === 0 ? 'active' : `previous_index_${matchedIdx}`;
  logger.info('whatsapp_webhook_signature_verified', { verifiedBy: secretType });
  next();
};

module.exports = verifyWhatsappSignature;
