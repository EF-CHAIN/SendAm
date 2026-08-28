const axios = require('axios');
const { randomUUID } = require('node:crypto');
const config = require('../config/env');
const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');
const { getContext, outboundHeaders } = require('../observability/context');
const { ProviderSkippedError } = require('../compliance/providerErrors');

// ---------------------------------------------------------------------------
// Delivery status state machine (#159)
//
// Meta's WhatsApp Cloud API webhook reports status callbacks out of band from
// the synchronous send response: sent -> delivered -> read, or a terminal
// failed. STATUS_RANK lets us reject a callback that would regress an
// already-more-advanced Notification (e.g. a late "sent" arriving after
// "delivered" was already recorded), and lets "failed" always win as
// terminal.
// ---------------------------------------------------------------------------
const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };
const MAX_OUTBOUND_RETRIES = 2;
const activeSendControllers = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForRetry = async (ms, sleepImpl, signal) => {
  if (signal.aborted) return;
  let onAbort;
  await Promise.race([
    sleepImpl(ms),
    new Promise((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', resolve, { once: true });
    }),
  ]);
  signal.removeEventListener('abort', onAbort);
};

const cancelInFlightSends = (reason = 'shutdown') => {
  for (const controller of activeSendControllers) controller.abort({ type: 'shutdown', message: reason });
  return activeSendControllers.size;
};

const errorDetails = (error, kind) => ({
  kind,
  status: error.response?.status || null,
  code: error.code || null,
  message: String(error.response?.data?.error?.message || error.message || kind).slice(0, 500),
});

const classifySynchronousFailure = (error, signal) => {
  if (signal.aborted) {
    const cancelled = ['shutdown', 'caller'].includes(signal.reason?.type);
    return { outcome: 'unknown', retryable: false, error: errorDetails(error, cancelled ? 'cancelled' : 'timeout') };
  }
  const status = error.response?.status;
  if (status === 429 || status >= 500) {
    return { outcome: 'transient_failure', retryable: true, error: errorDetails(error, 'http') };
  }
  if (status >= 400 && status < 500) {
    return { outcome: 'permanent_failure', retryable: false, error: errorDetails(error, 'http') };
  }
  if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) {
    return { outcome: 'unknown', retryable: false, error: errorDetails(error, 'timeout') };
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH'].includes(error.code)) {
    return { outcome: 'transient_failure', retryable: true, error: errorDetails(error, 'network') };
  }
  return { outcome: 'unknown', retryable: false, error: errorDetails(error, 'network') };
};

// Meta error codes seen on `statuses[].errors[].code`. Only failures known to
// be transient (rate limiting, temporary delivery problems) are retried.
// Anything about a blocked/opted-out recipient, an invalid number, or a
// closed messaging window is permanent and must never be retried
// automatically — retrying those just repeats the same rejection.
const RETRYABLE_ERROR_CODES = new Set([
  '131026', // Message undeliverable (transient — device/network issue)
  '131049', // Delivery delayed by Meta's per-recipient limits
  '130429', // Rate limit hit
  '131000', // Generic/unknown temporary failure
]);
const NON_RETRYABLE_ERROR_CODES = new Set([
  '131047', // Re-engagement: outside the 24h customer service window
  '131021', // Recipient cannot be a business / invalid recipient
  '131031', // Account has been restricted
  '368',    // Business account temporarily/permanently disabled
  '470',    // Message failed to send because of a policy violation
  '131052', // Media download failed
  '131053', // Media upload failed
]);

/**
 * Classify a Meta failure error code as safe to retry or not.
 * Unknown codes default to non-retryable — retrying a failure we cannot
 * classify risks looping on a permanent rejection.
 */
const classifyWhatsappFailure = (errorCode) => {
  const code = errorCode == null ? null : String(errorCode);
  if (code && RETRYABLE_ERROR_CODES.has(code)) return { retryable: true, reason: 'transient' };
  if (code && NON_RETRYABLE_ERROR_CODES.has(code)) return { retryable: false, reason: 'permanent' };
  return { retryable: false, reason: 'unknown' };
};

const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

const isWithinConversationWindow = (lastCustomerInteractionAt) => {
  if (!lastCustomerInteractionAt) return false;
  const lastTime = new Date(lastCustomerInteractionAt).getTime();
  if (Number.isNaN(lastTime)) return false;
  return Date.now() - lastTime <= CONVERSATION_WINDOW_MS;
};

const sendTemplateMessage = async (to, templateName, languageCode = 'en', components = [], options = {}) => {
  const {
    messageTransport = config.messageTransport,
    prisma = null,
    axiosImpl = axios,
    notification = null,
  } = options;

  const db = notification ? (prisma || require('../common/prisma')) : null;

  try {
    if (messageTransport === 'sim') {
      const simDb = prisma || require('../common/prisma');
      const body = `[Template: ${templateName}] ${JSON.stringify(components)}`;
      const result = await simDb.simMessage.create({
        data: {
          phoneNumber: to,
          direction: 'out',
          text: body,
        },
      });
      if (db && notification) {
        await recordNotificationCreated(db, notification, { to, body, providerMessageId: null, status: 'sent' });
      }
      return result;
    }

    const url = `https://graph.facebook.com/v19.0/${config.whatsapp.phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components && components.length ? { components } : {}),
      },
    };

    const response = await axiosImpl.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${config.whatsapp.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (db && notification) {
      const providerMessageId = response.data?.messages?.[0]?.id || null;
      await recordNotificationCreated(db, notification, {
        to,
        body: `[Template: ${templateName}]`,
        providerMessageId,
        status: providerMessageId ? 'sent' : 'queued',
      });
    }

    return response.data;
  } catch (error) {
    logger.error('WhatsApp Template API Error:', error.response?.data || error.message);
    if (db && notification) {
      await recordNotificationCreated(db, notification, {
        to,
        body: `[Template: ${templateName}]`,
        providerMessageId: null,
        status: 'failed',
        error: String(error.response?.data?.error?.message || error.message || 'template send failed').slice(0, 500),
      });
    }
    return null;
  }
};

/**
 * @typedef {'accepted'|'transient_failure'|'permanent_failure'|'unknown'} SendOutcome
 * @typedef {{outcome: SendOutcome, correlationId: string, attempts: number,
 *   providerMessageId?: string, retryable?: boolean, data?: object,
 *   error?: {kind: string, status: number|null, code: string|null, message: string}}} SendResult
 */

/** @returns {Promise<SendResult>} */
const sendTextMessage = async (to, body, options = {}) => {
  const {
    messageTransport = config.messageTransport,
    prisma = null,
    axiosImpl = axios,
    notification = null,
    enforceWindow = false,
    lastCustomerInteractionAt = null,
    templateName = null,
    templateLanguage = 'en',
    templateComponents = [],
    signal: callerSignal = null,
    correlationId: providedCorrelationId = null,
    sleepImpl = sleep,
  } = options;
  const correlationId = providedCorrelationId
    || getContext().correlationId
    || (notification?.referenceType && notification?.referenceId
      ? `${notification.referenceType}:${notification.referenceId}`
      : randomUUID());

  // Meta 24-hour Customer Service Window Enforcement (#190)
  if (enforceWindow && !isWithinConversationWindow(lastCustomerInteractionAt)) {
    if (templateName) {
      const data = await sendTemplateMessage(to, templateName, templateLanguage, templateComponents, options);
      const providerMessageId = data?.messages?.[0]?.id || null;
      return { outcome: data ? 'accepted' : 'unknown', providerMessageId, correlationId, attempts: 1, data };
    }
    logger.warn('whatsapp_window_expired', { to, lastCustomerInteractionAt });
    const db = notification ? (prisma || require('../common/prisma')) : null;
    if (db && notification) {
      await recordNotificationCreated(db, notification, {
        to,
        body,
        providerMessageId: null,
        status: 'failed',
        error: 'Meta customer service window expired (24h). Approved template required.',
      });
    }
    return {
      outcome: 'permanent_failure', retryable: false, correlationId, attempts: 1,
      error: { kind: 'conversation_window', status: null, code: null, message: 'Meta customer service window expired (24h). Approved template required.' },
    };
  }

  // Notification recording is opt-in: callers that care about delivery
  // lifecycle (financial receipts, deposit alerts, voice replies) pass
  // `notification`; low-stakes replies (menus, throttle warnings) don't pay
  // the write. Only touch prisma when there's something to record.
  const db = notification ? (prisma || require('../common/prisma')) : null;

  if (messageTransport === 'sim') {
    try {
      const simDb = prisma || require('../common/prisma');
      const result = await simDb.simMessage.create({
        data: {
          phoneNumber: to,
          direction: 'out',
          text: body,
        },
      });
      if (db && notification) {
        await recordNotificationCreated(db, notification, { to, body, providerMessageId: null, status: 'sent' });
      }
      return { outcome: 'accepted', providerMessageId: null, correlationId, attempts: 1, data: result };
    } catch (error) {
      return { outcome: 'permanent_failure', retryable: false, correlationId, attempts: 1, error: errorDetails(error, 'storage') };
    }
  }

  const url = `https://graph.facebook.com/${config.whatsapp.graphApiVersion || 'v19.0'}/${config.whatsapp.phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
    biz_opaque_callback_data: String(correlationId).slice(0, 512),
  };

  const controller = new AbortController();
  activeSendControllers.add(controller);
  const onCallerAbort = () => controller.abort({ type: 'caller', message: 'caller cancelled' });
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();
  const connectDeadline = setTimeout(
    () => controller.abort({ type: 'timeout', message: 'connection deadline exceeded' }),
    config.whatsapp.connectTimeoutMs,
  );
  connectDeadline.unref?.();

  let finalResult;
  const maxAttempts = Math.max(1, Number(config.whatsapp.maxSendRetries || 0) + 1);
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await axiosImpl.post(url, payload, {
          headers: {
            'Authorization': `Bearer ${config.whatsapp.token}`,
            'Content-Type': 'application/json',
            ...outboundHeaders(),
          },
          timeout: config.whatsapp.responseTimeoutMs,
          signal: controller.signal,
        });
        const providerMessageId = response.data?.messages?.[0]?.id;
        finalResult = providerMessageId && typeof providerMessageId === 'string'
          ? { outcome: 'accepted', providerMessageId, correlationId, attempts: attempt, data: response.data }
          : {
            outcome: 'unknown', retryable: false, correlationId, attempts: attempt,
            error: { kind: 'malformed_response', status: response.status || 200, code: null, message: 'Meta response did not contain a message id' },
          };
        break;
      } catch (error) {
        const classified = classifySynchronousFailure(error, controller.signal);
        finalResult = { ...classified, correlationId, attempts: attempt };
        if (!classified.retryable || attempt === maxAttempts) break;
        const retryAfterSeconds = Number(error.response?.headers?.['retry-after']);
        const delay = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : config.whatsapp.retryBaseDelayMs * (2 ** (attempt - 1));
        await waitForRetry(delay, sleepImpl, controller.signal);
        if (controller.signal.aborted) {
          finalResult = {
            outcome: 'unknown', retryable: false, correlationId, attempts: attempt,
            error: errorDetails(new Error('send cancelled'), controller.signal.reason?.type === 'timeout' ? 'timeout' : 'cancelled'),
          };
          break;
        }
      }
    }
  } finally {
    clearTimeout(connectDeadline);
    callerSignal?.removeEventListener('abort', onCallerAbort);
    activeSendControllers.delete(controller);
  }

  if (finalResult.outcome !== 'accepted') {
    logger.error('whatsapp_send_failed', { correlationId, ...finalResult.error, attempts: finalResult.attempts });
  }
  if (db && notification) {
    const status = finalResult.outcome === 'accepted'
      ? 'queued'
      : (finalResult.outcome === 'unknown' ? 'unknown' : 'failed');
    await recordNotificationCreated(db, notification, {
      to, body, providerMessageId: finalResult.providerMessageId || null, status,
      error: finalResult.error?.message || null,
    });
  }
  return finalResult;
};

/**
 * Persist the outbound side of a WhatsApp send as a Notification row. Kept
 * as a thin insert (no upsert-by-provider-id) so `sendTextMessage` stays a
 * simple fire-and-record boundary — the status webhook path
 * (`recordDeliveryStatus`) is what finds this row again later by
 * `providerMessageId` and advances it through the delivery lifecycle.
 */
const recordNotificationCreated = async (db, notification, { to, body, providerMessageId, status, error = null }) => {
  try {
    await db.notification.create({
      data: {
        userId: notification.userId || null,
        channel: notification.channel || 'whatsapp',
        type: notification.type || 'generic',
        recipient: to,
        body,
        status,
        providerMessageId,
        error,
        referenceType: notification.referenceType || null,
        referenceId: notification.referenceId || null,
        sentAt: status === 'sent' ? new Date() : null,
        failedAt: status === 'failed' ? new Date() : null,
        lastStatusAt: new Date(),
      },
    });
  } catch (dbError) {
    // Never let notification bookkeeping break the send path.
    logger.error('notification_create_failed', { message: dbError.message });
  }
};

/**
 * Record one Meta status callback entry (`value.statuses[i]` from the
 * webhook payload) idempotently and advance the matching Notification's
 * delivery lifecycle. Returns a `{ result }` outcome for observability —
 * callers should treat every outcome as a successful (200-worthy) parse,
 * even 'malformed'/'unmatched': Meta retries the webhook on non-2xx, and a
 * bad payload retried forever would just create a retry storm.
 *
 * Outcomes:
 *  - malformed:        payload shape/status/timestamp didn't parse — ignored
 *  - duplicate:        exact (id, status, timestamp) already recorded
 *  - unmatched:        valid status, but no Notification has this provider id
 *  - stale/out_of_order: a status that would regress an already-advanced row
 *  - terminal_ignored: the Notification already reached a terminal 'failed'
 *  - recorded:         Notification updated (and, if applicable, a bounded
 *                       retry was enqueued for a safe terminal failure)
 */
const recordDeliveryStatus = async (statusEntry, options = {}) => {
  const { prisma = null, enqueueImpl = null } = options;
  const db = prisma || require('../common/prisma');

  const providerMessageId = statusEntry?.id;
  const status = statusEntry?.status;
  const timestampRaw = statusEntry?.timestamp;

  if (!providerMessageId || typeof status !== 'string' || !STATUS_RANK[status] || timestampRaw == null) {
    increment('sendam_whatsapp_status_webhook_total', { result: 'malformed' });
    logger.warn('whatsapp_status_malformed', { statusEntry });
    return { result: 'malformed' };
  }

  const statusTimestamp = new Date(Number(timestampRaw) * 1000);
  if (Number.isNaN(statusTimestamp.getTime())) {
    increment('sendam_whatsapp_status_webhook_total', { result: 'malformed' });
    logger.warn('whatsapp_status_malformed', { statusEntry, reason: 'bad_timestamp' });
    return { result: 'malformed' };
  }

  const errorEntry = Array.isArray(statusEntry.errors) ? statusEntry.errors[0] : null;
  const errorCode = errorEntry?.code != null ? String(errorEntry.code) : null;
  const errorTitle = errorEntry?.title ? String(errorEntry.title).slice(0, 200) : null;
  const errorMessage = errorEntry?.message ? String(errorEntry.message).slice(0, 500) : null;

  try {
    await db.whatsappStatusEvent.create({
      data: {
        providerMessageId,
        status,
        statusTimestamp,
        recipientId: statusEntry.recipient_id || null,
        errorCode,
        errorTitle,
        errorMessage,
      },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      increment('sendam_whatsapp_status_webhook_total', { result: 'duplicate' });
      return { result: 'duplicate' };
    }
    throw err;
  }

  increment('sendam_whatsapp_delivery_status_total', { status });

  const record = await db.notification.findFirst({ where: { providerMessageId } });
  if (!record) {
    increment('sendam_whatsapp_status_webhook_total', { result: 'unmatched' });
    logger.info('whatsapp_status_unmatched', { providerMessageId, status });
    return { result: 'unmatched' };
  }

  if (record.status === 'failed') {
    increment('sendam_whatsapp_status_webhook_total', { result: 'terminal_ignored' });
    return { result: 'terminal_ignored' };
  }

  if (record.lastStatusAt && statusTimestamp < record.lastStatusAt) {
    increment('sendam_whatsapp_status_webhook_total', { result: 'out_of_order' });
    return { result: 'out_of_order' };
  }

  const currentRank = STATUS_RANK[record.status] || 0;
  const incomingRank = STATUS_RANK[status];
  if (incomingRank < currentRank) {
    increment('sendam_whatsapp_status_webhook_total', { result: 'out_of_order' });
    return { result: 'out_of_order' };
  }

  const data = { status, lastStatusAt: statusTimestamp };
  if (status === 'sent') data.sentAt = statusTimestamp;
  if (status === 'delivered') data.deliveredAt = statusTimestamp;
  if (status === 'read') data.readAt = statusTimestamp;

  let shouldRetry = false;
  if (status === 'failed') {
    data.failedAt = statusTimestamp;
    data.failureCode = errorCode;
    data.failureMessage = errorMessage || errorTitle || null;
    const classification = classifyWhatsappFailure(errorCode);
    data.retryable = classification.retryable;
    // Retry policy: only for safe/transient terminal failures, only on
    // messages tied to a domain reference (financial/transaction, voice
    // command, etc. — see referenceType/referenceId on Notification), and
    // bounded so a permanently-failing recipient can never loop forever.
    if (classification.retryable && (record.retryCount || 0) < MAX_OUTBOUND_RETRIES && record.referenceType) {
      data.retryCount = (record.retryCount || 0) + 1;
      shouldRetry = true;
    }
  }

  await db.notification.update({ where: { id: record.id }, data });
  increment('sendam_whatsapp_status_webhook_total', { result: 'recorded' });

  if (shouldRetry) {
    try {
      const enqueue = enqueueImpl || require('../queues/queue.service').enqueue;
      await enqueue('whatsapp-outbound-retry', 'notification.retry', {
        originalNotificationId: record.id,
        recipient: record.recipient,
        body: record.body,
        userId: record.userId,
        type: record.type,
        channel: record.channel,
        referenceType: record.referenceType,
        referenceId: record.referenceId,
      }, { jobId: `whatsapp-retry-${record.id}-${data.retryCount}` });
      increment('sendam_whatsapp_retry_total', { result: 'enqueued' });
    } catch (enqueueError) {
      logger.error('whatsapp_retry_enqueue_failed', { message: enqueueError.message, notificationId: record.id });
      increment('sendam_whatsapp_retry_total', { result: 'enqueue_failed' });
    }
  }

  return { result: 'recorded', notificationId: record.id, retried: shouldRetry };
};

// Best-effort customer data deletion at the messaging provider (Meta Platform
// data-deletion request). Gated behind an operator-configured deletion URL; when
// unconfigured it throws ProviderSkippedError so the privacy workflow records a
// visible "skipped" task rather than a failure.
const deleteUserData = async (phoneNumber) => {
  const url = config.whatsapp.dataDeletionUrl || process.env.WHATSAPP_DATA_DELETION_URL;
  if (!url) throw new ProviderSkippedError('WhatsApp data deletion not configured');
  await axios.post(url, {
    user_id: phoneNumber,
    app_id: config.whatsapp.appId || process.env.WHATSAPP_APP_ID,
  }, { timeout: 30000, headers: { 'content-type': 'application/json', ...outboundHeaders() } });
  return { status: 'success' };
};

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  isWithinConversationWindow,
  CONVERSATION_WINDOW_MS,
  recordDeliveryStatus,
  classifyWhatsappFailure,
  deleteUserData,
  STATUS_RANK,
  cancelInFlightSends,
  classifySynchronousFailure,
};
