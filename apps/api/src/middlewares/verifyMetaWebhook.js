'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');

const SIGNATURE_REGEX = /^sha256=[a-f0-9]{64}$/i;

/**
 * Validates a single raw body against an expected signature using timingSafeEqual.
 *
 * @param {Buffer|string} rawBody - Raw unparsed webhook payload.
 * @param {string} signature - Header signature value (e.g. "sha256=...").
 * @param {string} secret - Secret key to verify with.
 * @returns {boolean} True if signature cryptographically matches.
 */
function validateSignature(rawBody, signature, secret) {
  if (!signature || !secret || !rawBody) return false;
  if (!SIGNATURE_REGEX.test(signature)) return false;

  const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expectedSig = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBuffer)
    .digest('hex');

  const sigBuffer = Buffer.from(signature);
  const expBuffer = Buffer.from(expectedSig);

  if (sigBuffer.length !== expBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuffer, expBuffer);
}

/**
 * Resolves list of valid secrets from environment or config.
 */
function resolveSecrets(customSecret = null) {
  if (customSecret) {
    return Array.isArray(customSecret) ? customSecret : [customSecret];
  }

  const envSecret = process.env.WHATSAPP_APP_SECRET || config.whatsapp?.appSecret;
  if (envSecret) {
    return envSecret.split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (Array.isArray(config.whatsapp?.appSecrets) && config.whatsapp.appSecrets.length > 0) {
    return config.whatsapp.appSecrets;
  }

  return [];
}

/**
 * Factory to create verifyMetaWebhook middleware with custom options (useful for testing or custom handlers).
 */
function createVerifyMetaWebhook({
  appSecret = null,
  onSecurityAlert = null,
} = {}) {
  return function verifyMetaWebhookMiddleware(req, res, next) {
    const signature = req.get('X-Hub-Signature-256') || req.headers['x-hub-signature-256'] || '';
    const rawBody = req.rawBody !== undefined ? req.rawBody : (Buffer.isBuffer(req.body) ? req.body : null);
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';

    const triggerSecurityAlert = (reason, details = {}) => {
      logger.warn('meta_webhook_security_alert', {
        event: 'meta_webhook_rejected',
        reason,
        ip,
        userAgent: req.get('User-Agent') || 'unknown',
        ...details,
      });

      try {
        increment('sendam_webhook_security_alerts_total', { reason });
      } catch (_err) {
        // Safe fallback if metrics unavailable
      }

      if (typeof onSecurityAlert === 'function') {
        try {
          onSecurityAlert(reason, { ip, signature, ...details });
        } catch (_cbErr) {
          // ignore callback error
        }
      }
    };

    // Missing signature
    if (!signature) {
      triggerSecurityAlert('missing_signature');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing required X-Hub-Signature-256 header',
      });
    }

    // Malformed signature header
    if (!SIGNATURE_REGEX.test(signature)) {
      triggerSecurityAlert('malformed_signature', { signatureSnippet: signature.slice(0, 16) });
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Malformed X-Hub-Signature-256 header format',
      });
    }

    // Missing raw body
    if (rawBody === null || rawBody === undefined) {
      triggerSecurityAlert('missing_raw_body');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Request raw body is unavailable for signature verification',
      });
    }

    const secrets = resolveSecrets(appSecret);
    if (secrets.length === 0) {
      if (config.isProduction) {
        triggerSecurityAlert('unconfigured_secret_in_production');
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Webhook verification secret not configured',
        });
      }
      logger.warn('WHATSAPP_APP_SECRET is not configured; skipping verification in non-production environment');
      return next();
    }

    // Verify against all active / rotation secrets using crypto.timingSafeEqual
    let matched = false;
    for (const secret of secrets) {
      if (validateSignature(rawBody, signature, secret)) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      triggerSecurityAlert('forged_signature', {
        signatureSnippet: signature.slice(0, 16),
      });
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid X-Hub-Signature-256 signature',
      });
    }

    logger.info('meta_webhook_signature_verified', { ip });
    return next();
  };
}

const verifyMetaWebhook = createVerifyMetaWebhook();

module.exports = verifyMetaWebhook;
module.exports.createVerifyMetaWebhook = createVerifyMetaWebhook;
module.exports.validateSignature = validateSignature;
