'use strict';

// Outbound partner webhook dispatcher (#1013).
//
// Payment events are delivered to a partner's backend over HTTPS, signed with a
// per-partner HMAC-SHA256 secret, through the durable `partner-webhooks` queue.
//
// Partner configuration lives in `Partner.config.webhook`:
//   { enabled: true, url: "https://partner.example/hooks", secretEncrypted: "<crypto.service ciphertext>" }
// The signing secret is never stored or logged in plaintext; use
// `buildWebhookConfig()` to produce the stored shape.
//
// Wire format (what a partner verifies):
//   X-SendAm-Timestamp: <unix seconds>
//   X-SendAm-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
// Binding the timestamp into the MAC lets receivers reject replays.
//
// Delivery succeeds on any 2xx. Anything else (non-2xx, timeout, network error)
// is retried with exponential backoff: 1 initial attempt + 5 retries.

const crypto = require('node:crypto');
const net = require('node:net');
const logger = require('../utils/logger');
const { increment, observeDuration } = require('../observability/metrics');

const QUEUE_NAME = 'partner-webhooks';
const JOB_NAME = 'partner.webhook';
const AUDIT_ACTION = 'partner_webhook.delivery';

const MAX_RETRIES = 5;
const MAX_ATTEMPTS = MAX_RETRIES + 1;
const BACKOFF_BASE_MS = 2000;
const REQUEST_TIMEOUT_MS = 10000;
const SIGNATURE_TOLERANCE_SECONDS = 300;

const SIGNATURE_HEADER = 'X-SendAm-Signature';
const TIMESTAMP_HEADER = 'X-SendAm-Timestamp';
const EVENT_HEADER = 'X-SendAm-Event';
const DELIVERY_HEADER = 'X-SendAm-Delivery';

const defaultCrypto = () => require('./crypto.service');

/** HMAC-SHA256 over `${timestamp}.${body}`, formatted `sha256=<hex>`. */
const signPayload = (secret, timestamp, body) => {
  if (!secret) throw new Error('Webhook signing secret is required');
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `sha256=${mac}`;
};

/**
 * Receiver-side verification, exported so partners' SDKs, docs and our tests
 * share one reference implementation.
 */
const verifySignature = ({
  secret, timestamp, body, signature, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS, now = Date.now(),
}) => {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const received = Buffer.from(String(signature));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
};

const isPrivateHost = (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  if (net.isIPv6(host)) {
    return host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  }
  return false;
};

/**
 * Reject endpoints that would turn the dispatcher into an SSRF primitive.
 * Hostnames are checked lexically only; resolved addresses are not re-checked.
 */
const validateWebhookUrl = (rawUrl, { allowInsecure = false } = {}) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_error) {
    throw new Error('Webhook URL is not a valid URL');
  }
  if (url.username || url.password) throw new Error('Webhook URL must not embed credentials');
  if (!allowInsecure) {
    if (url.protocol !== 'https:') throw new Error('Webhook URL must use https');
    if (isPrivateHost(url.hostname)) throw new Error('Webhook URL must not target a private or local host');
  } else if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Webhook URL must use http or https');
  }
  return url.toString();
};

/** Produce the `Partner.config.webhook` value, encrypting the signing secret. */
const buildWebhookConfig = ({ url, secret, enabled = true }, { allowInsecure = false, cryptoService = defaultCrypto() } = {}) => {
  if (!secret || String(secret).length < 16) throw new Error('Webhook secret must be at least 16 characters');
  return {
    enabled,
    url: validateWebhookUrl(url, { allowInsecure }),
    secretEncrypted: cryptoService.encrypt(String(secret)),
  };
};

const resolveWebhookConfig = (partner, { cryptoService } = {}) => {
  const webhook = partner?.config?.webhook;
  if (!webhook || webhook.enabled === false || !webhook.url || !webhook.secretEncrypted) return null;
  const svc = cryptoService || defaultCrypto();
  return { url: webhook.url, secret: svc.decrypt(webhook.secretEncrypted) };
};

const buildDeliveryRequest = ({ secret, eventType, deliveryId, payload, now = Date.now() }) => {
  const timestamp = String(Math.floor(now / 1000));
  const body = JSON.stringify({
    id: deliveryId,
    type: eventType,
    created: Number(timestamp),
    data: payload,
  });
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'SendAm-Webhooks/1.0',
      [EVENT_HEADER]: eventType,
      [DELIVERY_HEADER]: deliveryId,
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signPayload(secret, timestamp, body),
    },
  };
};

/**
 * Queue a webhook for a partner. The deterministic jobId makes re-dispatch of
 * the same logical event idempotent while the job is still retained.
 */
const dispatchPartnerWebhook = async ({
  partnerId, eventType, payload, deliveryId, enqueue,
}) => {
  if (!partnerId || !eventType) throw new Error('partnerId and eventType are required');
  const enqueueFn = enqueue || require('../queues/queue.service').enqueue;
  const id = deliveryId || `whd_${crypto.randomUUID()}`;
  const job = await enqueueFn(QUEUE_NAME, JOB_NAME, { partnerId, eventType, payload, deliveryId: id }, {
    jobId: id,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: BACKOFF_BASE_MS },
  });
  increment('sendam_partner_webhooks_total', { status: 'enqueued' });
  return { deliveryId: id, job };
};

/** Convenience for the payment-settlement event. */
const notifyPaymentSettled = (partnerId, transaction, deps = {}) => dispatchPartnerWebhook({
  partnerId,
  eventType: 'payment.settled',
  payload: {
    transactionId: transaction.id,
    status: transaction.status,
    amount: transaction.amount,
    asset: transaction.asset,
    transactionHash: transaction.txHash || null,
    settledAt: new Date().toISOString(),
  },
  ...deps,
});

/**
 * Queue processor. Throws on a failed delivery so BullMQ retries with backoff;
 * after the final attempt the queue service moves the job to the DLQ.
 * Every attempt is written to the audit log with status and latency; neither
 * the secret nor the payload body is logged.
 */
const processPartnerWebhookJob = async (job, deps = {}) => {
  const db = deps.db || require('../common/prisma');
  const httpClient = deps.httpClient || require('axios');
  const audit = deps.audit || require('../common/audit.service').writeAuditLog;
  const allowInsecure = deps.allowInsecure ?? process.env.NODE_ENV !== 'production';
  const now = deps.now || Date.now;

  const { partnerId, eventType, payload, deliveryId } = job.data || {};
  const attempt = (job.attemptsMade || 0) + 1;

  const record = async (outcome) => {
    increment('sendam_partner_webhooks_total', { status: outcome.status });
    if (outcome.latencyMs !== undefined) {
      observeDuration('sendam_partner_webhook_latency_seconds', { status: outcome.status }, outcome.latencyMs / 1000);
    }
    await audit({
      actorType: 'system',
      action: AUDIT_ACTION,
      entityType: 'partner',
      entityId: partnerId,
      metadata: { deliveryId, eventType, attempt, maxAttempts: MAX_ATTEMPTS, ...outcome },
    });
  };

  const partner = await db.partner.findUnique({ where: { id: partnerId } });
  const target = partner && partner.status === 'active'
    ? resolveWebhookConfig(partner, { cryptoService: deps.cryptoService })
    : null;
  if (!target) {
    // Nothing to retry: a missing/suspended partner or absent config will not fix itself.
    await record({ status: 'skipped', reason: partner ? 'webhook_not_configured_or_inactive' : 'partner_not_found' });
    return { delivered: false, skipped: true };
  }

  let url;
  try {
    url = validateWebhookUrl(target.url, { allowInsecure });
  } catch (error) {
    await record({ status: 'skipped', reason: 'invalid_url', error: error.message });
    return { delivered: false, skipped: true };
  }

  const { body, headers } = buildDeliveryRequest({ secret: target.secret, eventType, deliveryId, payload, now: now() });
  const started = now();
  let responseStatus = null;
  let errorMessage = null;
  try {
    const response = await httpClient.post(url, body, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      transformRequest: [(data) => data],
    });
    responseStatus = response.status;
  } catch (error) {
    errorMessage = String(error.code || error.message).slice(0, 200);
  }
  const latencyMs = now() - started;

  if (responseStatus !== null && responseStatus >= 200 && responseStatus < 300) {
    await record({ status: 'delivered', responseStatus, latencyMs });
    return { delivered: true, responseStatus, latencyMs };
  }

  await record({ status: 'failed', responseStatus, latencyMs, ...(errorMessage ? { error: errorMessage } : {}) });
  logger.warn('partner_webhook_delivery_failed', { partnerId, deliveryId, attempt, responseStatus });
  throw new Error(`Partner webhook delivery failed (${responseStatus ?? errorMessage})`);
};

module.exports = {
  QUEUE_NAME,
  JOB_NAME,
  AUDIT_ACTION,
  MAX_RETRIES,
  MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signPayload,
  verifySignature,
  validateWebhookUrl,
  buildWebhookConfig,
  resolveWebhookConfig,
  buildDeliveryRequest,
  dispatchPartnerWebhook,
  notifyPaymentSettled,
  processPartnerWebhookJob,
};
