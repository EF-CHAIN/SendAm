'use strict';

/**
 * External Integration Schema Validation (#321)
 * -----------------------------------------------
 * Defines JSON schemas for every external provider payload and enforces them
 * at the inbound boundary. Malformed or suspicious payloads are rejected early
 * with a structured error log so schema failures are traceable and auditable.
 *
 * Usage (middleware):
 *   router.post('/callback/smileid', validateExternalPayload('smileid.callback'), handler);
 *
 * Usage (direct validation):
 *   const { validatePayload } = require('./validation');
 *   const { valid, errors } = validatePayload('whatsapp.message', body);
 */

const logger = require('../utils/logger');

// ── Schema registry ───────────────────────────────────────────────────────
// Each schema is a lightweight structural descriptor:
//   required   — field paths that must be present and non-null
//   strings    — fields that must be strings (non-empty by default)
//   numbers    — fields that must be numeric
//   oneOf      — field must equal one of the provided values
//   arrays     — fields that must be arrays
//   custom     — additional predicate functions for complex rules
//
// This is intentionally simple (no external deps) to avoid a heavy
// validation library and to keep the boundary check transparent.

const SCHEMAS = {
  // ── WhatsApp Cloud API inbound message ────────────────────────────────
  'whatsapp.message': {
    required: ['object', 'entry'],
    arrays: ['entry'],
    custom: [
      {
        name: 'entry_not_empty',
        fn: (body) => Array.isArray(body.entry) && body.entry.length > 0,
        message: 'entry array must not be empty',
      },
      {
        name: 'object_is_whatsapp_business_account',
        fn: (body) => body.object === 'whatsapp_business_account',
        message: 'object must be "whatsapp_business_account"',
      },
    ],
  },

  // ── WhatsApp webhook verification (GET) ───────────────────────────────
  'whatsapp.verify': {
    required: ['hub.mode', 'hub.verify_token', 'hub.challenge'],
    strings: ['hub.mode', 'hub.verify_token', 'hub.challenge'],
    custom: [
      {
        name: 'mode_is_subscribe',
        fn: (body) => body['hub.mode'] === 'subscribe',
        message: 'hub.mode must be "subscribe"',
      },
    ],
  },

  // ── Smile ID KYC callback ─────────────────────────────────────────────
  'smileid.callback': {
    required: ['ResultCode', 'ResultText', 'SmileJobID', 'PartnerParams', 'signature', 'timestamp'],
    strings: ['ResultCode', 'ResultText', 'SmileJobID', 'signature', 'timestamp'],
    custom: [
      {
        name: 'partner_params_shape',
        fn: (body) => {
          const p = body.PartnerParams || body.partner_params || {};
          return typeof p === 'object' && p !== null && typeof p.job_id === 'string' && typeof p.user_id === 'string';
        },
        message: 'PartnerParams must contain string job_id and user_id',
      },
      {
        name: 'result_code_is_string',
        fn: (body) => /^\d+$/.test(String(body.ResultCode || '')),
        message: 'ResultCode must be a numeric string',
      },
    ],
  },

  // ── Generic KYC provider callback (other providers) ──────────────────
  'kyc.callback.generic': {
    required: ['event', 'reference'],
    strings: ['event', 'reference'],
    oneOf: {
      event: ['verification.completed', 'verification.failed', 'verification.pending'],
    },
  },

  // ── Stellar Horizon deposit event (from deposit poller) ───────────────
  'stellar.payment': {
    required: ['id', 'type', 'paging_token'],
    strings: ['id', 'type', 'paging_token'],
    custom: [
      {
        name: 'type_is_payment_or_create_account',
        fn: (body) => ['payment', 'create_account'].includes(body.type),
        message: 'type must be "payment" or "create_account"',
      },
    ],
  },

  // ── ExchangeRate API response ─────────────────────────────────────────
  'exchangerate.response': {
    required: ['result', 'conversion_rates'],
    custom: [
      {
        name: 'result_success',
        fn: (body) => body.result === 'success',
        message: 'result must be "success"',
      },
      {
        name: 'conversion_rates_is_object',
        fn: (body) =>
          typeof body.conversion_rates === 'object' &&
          body.conversion_rates !== null &&
          !Array.isArray(body.conversion_rates),
        message: 'conversion_rates must be an object',
      },
    ],
  },

  // ── CoinGecko price response ──────────────────────────────────────────
  'coingecko.price': {
    required: [],
    custom: [
      {
        name: 'is_non_empty_object',
        fn: (body) =>
          typeof body === 'object' &&
          body !== null &&
          !Array.isArray(body) &&
          Object.keys(body).length > 0,
        message: 'CoinGecko response must be a non-empty object',
      },
    ],
  },

  // ── Deepgram transcription callback ──────────────────────────────────
  'deepgram.response': {
    required: ['results'],
    custom: [
      {
        name: 'channels_present',
        fn: (body) =>
          body.results &&
          Array.isArray(body.results.channels) &&
          body.results.channels.length > 0,
        message: 'results.channels must be a non-empty array',
      },
    ],
  },
};

// ── Core validator ────────────────────────────────────────────────────────

/**
 * Validate `body` against the named schema.
 * @param {string} schemaName  Key from SCHEMAS.
 * @param {unknown} body       Request body or event payload.
 * @returns {{ valid: boolean, errors: string[] }}
 */
const validatePayload = (schemaName, body) => {
  const schema = SCHEMAS[schemaName];
  if (!schema) {
    return { valid: false, errors: [`Unknown schema: "${schemaName}"`] };
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { valid: false, errors: ['Payload must be a JSON object'] };
  }

  const errors = [];

  // Required field presence check
  for (const field of schema.required || []) {
    if (body[field] === undefined || body[field] === null) {
      errors.push(`Missing required field: "${field}"`);
    }
  }

  // String type checks (non-empty)
  for (const field of schema.strings || []) {
    if (body[field] !== undefined && body[field] !== null) {
      if (typeof body[field] !== 'string' || body[field].trim() === '') {
        errors.push(`Field "${field}" must be a non-empty string`);
      }
    }
  }

  // Numeric type checks
  for (const field of schema.numbers || []) {
    if (body[field] !== undefined && body[field] !== null) {
      if (typeof body[field] !== 'number' || Number.isNaN(body[field])) {
        errors.push(`Field "${field}" must be a number`);
      }
    }
  }

  // Array type checks
  for (const field of schema.arrays || []) {
    if (body[field] !== undefined && body[field] !== null) {
      if (!Array.isArray(body[field])) {
        errors.push(`Field "${field}" must be an array`);
      }
    }
  }

  // oneOf enum checks
  for (const [field, allowed] of Object.entries(schema.oneOf || {})) {
    if (body[field] !== undefined && body[field] !== null) {
      if (!allowed.includes(body[field])) {
        errors.push(`Field "${field}" must be one of: ${allowed.join(', ')}`);
      }
    }
  }

  // Custom predicate checks
  for (const check of schema.custom || []) {
    try {
      if (!check.fn(body)) {
        errors.push(check.message);
      }
    } catch (err) {
      errors.push(`Validation check "${check.name}" threw: ${err.message}`);
    }
  }

  return { valid: errors.length === 0, errors };
};

// ── Express middleware factory ────────────────────────────────────────────

/**
 * Returns an Express middleware that validates `req.body` against `schemaName`
 * and rejects malformed payloads with a 400, logging the schema failure for
 * traceability.
 *
 * @param {string} schemaName
 * @param {{ allowUnknown?: boolean }} [options]
 */
const validateExternalPayload = (schemaName, options = {}) => (req, res, next) => {
  const { valid, errors } = validatePayload(schemaName, req.body);

  if (!valid) {
    logger.warn('external_payload_schema_violation', {
      schema: schemaName,
      errors,
      path: req.path,
      method: req.method,
      // Never log the full body — it may contain PII or secrets.
      bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
    });

    return res.status(400).json({
      success: false,
      message: 'Payload failed schema validation',
      code: 'SCHEMA_VALIDATION_FAILED',
      errors,
    });
  }

  return next();
};

module.exports = {
  validatePayload,
  validateExternalPayload,
  SCHEMAS,
};
