const { sendTextMessage, recordDeliveryStatus } = require('../services/whatsapp.service');
const { replies } = require('../services/agent/replies');
const { consume } = require('../services/rateLimit.service');
const config = require('../config/env');
const logger = require('../utils/logger');
const { enqueue } = require('../queues/queue.service');
const prisma = require('../common/prisma');
const { increment } = require('../observability/metrics');
const { captureException } = require('../observability/errors');
const { canonicalizePhoneNumber } = require('../utils/validators');

const { validateWebhookEnvelope, validateInboundMessage, validateStatusEntry } = require('../whatsapp/webhook.validator');

/** Outcome labels for a single inbound message item within a batch. */
const OUTCOMES = {
  ENQUEUED: 'enqueued',
  DUPLICATE: 'duplicate',
  THROTTLED: 'throttled',
  INVALID: 'invalid',
  UNSUPPORTED: 'unsupported',
  INVALID_PHONE: 'invalid_phone',
  CLAIMING_CONFLICT: 'claiming_conflict',
  FAILED: 'failed',
};

/**
 * A message claiming row may be left in `claiming` when the item is
 * intentionally not enqueued (throttled, bad sender, unsupported). Leaving a
 * `claiming` row behind would make every Meta redelivery loop on a 503
 * forever, so we advance it to a terminal state. `queued` means "handled"
 * here, not that a durable job exists; it is only used to make retries
 * idempotent.
 */
const releaseClaim = async (messageId, status) => {
  await prisma.processedMessage.updateMany({
    where: { messageId, status: 'claiming' },
    data: { status, lastError: null },
  });
};

/**
 * Process a single supported inbound message independently. Returns an
 * outcome object so the caller can decide aggregate acknowledgement semantics
 * (partial-failure retry) without one bad item discarding the rest.
 */
const processMessage = async ({ message, value }) => {
  const msgValidation = validateInboundMessage(message);
  if (!msgValidation.valid) {
    logger.warn('whatsapp_webhook_invalid_message_payload', { reason: msgValidation.reason, message });
    increment('sendam_webhook_events_total', { status: 'invalid_schema' });
    return { outcome: OUTCOMES.INVALID };
  }

  if (!['text', 'audio', 'voice'].includes(message.type)) {
    return { outcome: OUTCOMES.UNSUPPORTED };
  }

  // Idempotency: Meta redelivers un-acked events, so dedup on message id
  // before doing anything with side effects. A duplicate insert throws on the
  // unique index and we bail out without reprocessing. This is what makes a
  // Meta retry after a partial batch failure harmless — already accepted
  // message ids resolve to `duplicate` instead of being enqueued again.
  let claimedMessageId = null;
  if (message.id) {
    try {
      await prisma.processedMessage.create({
        data: { messageId: message.id, status: 'claiming' },
      });
      claimedMessageId = message.id;
    } catch (err) {
      if (err.code === 'P2002') {
        const existing = await prisma.processedMessage.findUnique({ where: { messageId: message.id } });
        if (existing?.status === 'failed') {
          const reclaimed = await prisma.processedMessage.updateMany({
            where: { messageId: message.id, status: 'failed' },
            data: { status: 'claiming', lastError: null },
          });
          if (reclaimed.count === 1) claimedMessageId = message.id;
        }
        if (!claimedMessageId) {
          logger.info(`Skipping duplicate WhatsApp message ${message.id}`);
          increment('sendam_webhook_events_total', { status: 'duplicate' });
          // A claiming row may belong to a concurrent request. Signal a
          // retryable response so the caller does not acknowledge prematurely.
          if (existing?.status === 'claiming') return { outcome: OUTCOMES.CLAIMING_CONFLICT };
          return { outcome: OUTCOMES.DUPLICATE };
        }
      } else {
        throw err;
      }
    }
  }

  let from = message.from;
  try {
    from = canonicalizePhoneNumber(from);
  } catch (_err) {
    logger.warn(`Received webhook message from invalid phone number: ${message.from}`);
    if (claimedMessageId) {
      await releaseClaim(claimedMessageId, 'queued').catch((e) => {
        logger.error('webhook_delivery_state_release_failed', { message: e.message });
      });
    }
    return { outcome: OUTCOMES.INVALID_PHONE };
  }

  const whatsappName = value?.contacts?.[0]?.profile?.name || '';

  // Per-sender throttle. We don't 429 here (that would make Meta retry and
  // flag the webhook unhealthy) — instead we drop excess messages, warning
  // the sender once at the threshold and staying quiet after that. The claim
  // is released so a redelivery is not permanently stuck.
  const { botMax, botWindowMs } = config.rateLimit;
  const { totalHits } = await consume(`wa:${from}`, botWindowMs);
  if (totalHits > botMax) {
    logger.warn(`Throttling WhatsApp sender ${from} (${totalHits} msgs in window)`);
    increment('sendam_webhook_events_total', { status: 'throttled' });
    if (totalHits === botMax + 1) {
      sendTextMessage(from, replies.rateLimited());
    }
    if (claimedMessageId) {
      await releaseClaim(claimedMessageId, 'queued').catch((e) => {
        logger.error('webhook_delivery_state_release_failed', { message: e.message });
      });
    }
    return { outcome: OUTCOMES.THROTTLED };
  }

  const options = message.id ? { jobId: message.id } : {};
  // Meta's inbound timestamp (unix seconds) is the source of truth for
  // per-sender message ordering — see queues/ordering.service.js. It's
  // preserved through the job data rather than relying on enqueue order,
  // since redelivered/out-of-order webhook events would otherwise be ordered
  // by arrival at this process instead of by what the customer actually sent
  // first.
  const providerTimestamp = message.timestamp ? Number(message.timestamp) * 1000 : undefined;
  try {
    await enqueue('whatsapp-inbound', 'message.received', {
      from,
      whatsappName,
      text: message.text?.body,
      mediaId: message.audio?.id || message.voice?.id,
      messageType: message.type,
      whatsappMessageId: message.id,
      providerTimestamp,
    }, options);
  } catch (queueError) {
    increment('sendam_webhook_events_total', { status: 'failed' });
    logger.error('webhook_enqueue_error', { messageId: message.id, message: queueError.message });
    captureException(queueError, { source: 'webhook', messageId: message.id });
    // Preserve a recoverable durable state. A later Meta delivery atomically
    // reclaims only failed rows; concurrent claiming/queued work is untouched.
    if (claimedMessageId) {
      await prisma.processedMessage.updateMany({
        where: { messageId: claimedMessageId, status: 'claiming' },
        data: { status: 'failed', lastError: String(queueError.message).slice(0, 500) },
      }).catch((cleanupError) => {
        logger.error('Webhook delivery state recovery failed:', cleanupError);
        captureException(cleanupError, { source: 'webhook_cleanup' });
      });
    }
    return { outcome: OUTCOMES.FAILED, error: queueError };
  }

  increment('sendam_webhook_events_total', { status: 'enqueued' });
  if (claimedMessageId) {
    await prisma.processedMessage.updateMany({
      where: { messageId: claimedMessageId, status: 'claiming' },
      data: { status: 'queued', lastError: null },
    });
  }
  return { outcome: OUTCOMES.ENQUEUED };
};

/**
 * Transport adapter for the WhatsApp Cloud API webhook. Its only jobs are
 * acknowledging the event quickly, flattening every supported entry, change,
 * status group and message into independent work, and queueing it in the
 * background. All conversation/payment logic lives outside the webhook
 * request path so Meta retries never duplicate money movement.
 *
 * Every message and status in the batch is processed independently so one
 * malformed sibling can't discard the rest. A retryable failure in any item
 * makes the whole batch return 503 so Meta redelivers it; already accepted
 * work is deduped by message id on retry (never queued twice).
 *
 * The POST signature is verified upstream (verifyWhatsappSignature middleware).
 */
const handleIncomingMessage = async (req, res) => {
  increment('sendam_webhook_events_total', { status: 'received' });
  try {
    const body = req.body;
    const envelopeValidation = validateWebhookEnvelope(body);
    if (!envelopeValidation.valid) {
      logger.warn('whatsapp_webhook_invalid_envelope', { reason: envelopeValidation.reason });
      increment('sendam_webhook_events_total', { status: 'invalid_schema' });
      return res.status(200).send('EVENT_RECEIVED');
    }

    let retryableFailure = false;

    for (const entry of body.entry) {
      if (!entry?.changes || !Array.isArray(entry.changes)) continue;
      for (const change of entry.changes) {
        const value = change?.value;
        if (!value || typeof value !== 'object') continue;

        // Delivery receipts (sent/delivered/read/failed) arrive on the same
        // webhook as inbound messages, as `value.statuses`. They report on
        // messages *we* sent, so they never carry conversation side effects —
        // just record them and keep going. Each status is handled
        // independently so one malformed status can't drop the rest, and a
        // recording failure is logged/observed rather than thrown, so a status
        // callback never turns into a 5xx that makes Meta retry the whole batch.
        const statuses = value.statuses;
        if (Array.isArray(statuses) && statuses.length) {
          for (const statusEntry of statuses) {
            const statusValidation = validateStatusEntry(statusEntry);
            if (!statusValidation.valid) {
              logger.warn('whatsapp_webhook_invalid_status_entry', { reason: statusValidation.reason, statusEntry });
              increment('sendam_webhook_events_total', { status: 'invalid_schema' });
              continue;
            }
            try {
              await recordDeliveryStatus(statusEntry);
            } catch (statusError) {
              logger.error('whatsapp_status_processing_error', { message: statusError.message });
              captureException(statusError, { source: 'webhook_status' });
            }
          }
        }

        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const message of messages) {
          try {
            const result = await processMessage({ message, value });
            if (result.outcome === OUTCOMES.FAILED || result.outcome === OUTCOMES.CLAIMING_CONFLICT) {
              retryableFailure = true;
            }
          } catch (itemError) {
            // An unexpected error processing a single item must not discard
            // the rest of the batch; count it as retryable and continue.
            logger.error('webhook_batch_item_error', { message: itemError.message });
            captureException(itemError, { source: 'webhook' });
            retryableFailure = true;
          }
        }
      }
    }

    // Partial-failure acknowledgement: if any item needed retryable work that
    // did not complete (queue unavailable, claiming conflict, unexpected
    // error), return 503 so Meta redelivers the batch. Already accepted
    // message ids resolve to `duplicate` on the retry, so nothing is double
    // enqueued and only the failed items are reclaimed.
    if (retryableFailure) {
      increment('sendam_webhook_events_total', { status: 'failed' });
      if (!res.headersSent) return res.status(503).send('QUEUE_UNAVAILABLE');
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    increment('sendam_webhook_events_total', { status: 'failed' });
    logger.error('webhook_processing_error', error);
    captureException(error, { source: 'webhook' });
    if (!res.headersSent) return res.status(503).send('QUEUE_UNAVAILABLE');
  }
};

module.exports = {
  handleIncomingMessage,
};
