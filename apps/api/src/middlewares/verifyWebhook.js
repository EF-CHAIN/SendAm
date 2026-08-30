const config = require('../config/env');
const crypto = require('crypto');
const logger = require('../utils/logger');

const tokensMatch = (received, expected) => {
  if (!received || !expected) return false;
  const receivedBuffer = Buffer.from(String(received));
  const expectedBuffer = Buffer.from(String(expected));
  return receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
};

const verifyWebhook = (req, res, next) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (typeof mode !== 'string' || typeof token !== 'string'
    || typeof challenge !== 'string' || challenge.length === 0) {
    logger.warn('whatsapp_webhook_verification_rejected', { reason: 'malformed_request' });
    return res.sendStatus(400);
  }
  if (mode !== 'subscribe' || !tokensMatch(token, config.whatsapp.verifyToken)) {
    logger.warn('whatsapp_webhook_verification_rejected', { reason: 'invalid_credentials' });
    return res.sendStatus(403);
  }

  logger.info('whatsapp_webhook_verification_succeeded');
  res.set('Cache-Control', 'no-store');
  return next();
};

module.exports = verifyWebhook;
module.exports.tokensMatch = tokensMatch;
