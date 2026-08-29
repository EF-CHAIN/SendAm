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

/**
 * Transport adapter for the WhatsApp Cloud API webhook. Its only jobs are
 * acknowledging the event quickly, extracting the inbound WhatsApp message,
 * and queueing background work. All conversation/payment logic lives outside
 * the webhook request path so Meta retries never duplicate money movement.
 *
 * The POST signature is verified upstream (verifyWhatsappSignature middleware).
 */
const handleIncomingMessage = async (req, res) => {
  increment('sendam_webhook_events_total', { status: 'received' });
  let claimedMessageId = null;
  try {
    const body = req.body;
    const envelopeValidation = validateWebhookEnvelope(body);
    if (!envelopeValidation.valid) {
      logger.warn('whatsapp_webhook_invalid_envelope', { reason: envelopeValidation.reason });
      increment('sendam_webhook_events_total', { status: 'invalid_schema' });
      return res.status(200).send('EVENT_RECEIVED');
    }

    const value = body.entry?.[0]?.changes?.[0]?.value;

    // Delivery receipts (sent/delivered/read/failed) arrive on the same
    // webhook as inbound messages, as `value.statuses`. They report on
    // messages *we* sent, so they never carry conversation side effects —
    // just record them and keep going. Each entry is handled independently
    // so one malformed entry can't drop the rest of the batch, and a
    // recording failure is logged/observed rather than thrown, so a status
    // callback never turns into a 5xx that makes Meta retry the whole batch.
    const statuses = value?.statuses;
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

    const message = value?.messages?.[0];
    if (!message) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const msgValidation = validateInboundMessage(message);
    if (!msgValidation.valid) {
      logger.warn('whatsapp_webhook_invalid_message_payload', { reason: msgValidation.reason, message });
      increment('sendam_webhook_events_total', { status: 'invalid_schema' });
      return res.status(200).send('EVENT_RECEIVED');
    }

    if (!['text', 'audio', 'voice'].includes(message.type)) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    // Idempotency: Meta redelivers un-acked events, so dedup on message id
    // before doing anything with side effects. A duplicate insert throws on
    // the unique index and we bail out without reprocessing.
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
            // A claiming row may belong to a concurrent request. Returning a
            // retryable response prevents premature acknowledgement.
            if (existing?.status === 'claiming') return res.status(503).send('ENQUEUE_IN_PROGRESS');
            return res.status(200).send('EVENT_RECEIVED');
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
      return res.status(200).send('EVENT_RECEIVED');
    }

    const whatsappName = value?.contacts?.[0]?.profile?.name || '';

    // Per-sender throttle. We don't 429 here (that would make Meta retry and
    // flag the webhook unhealthy) — instead we drop excess messages, warning
    // the sender once at the threshold and staying quiet after that.
    const { botMax, botWindowMs } = config.rateLimit;
    const { totalHits } = await consume(`wa:${from}`, botWindowMs);
    if (totalHits > botMax) {
      logger.warn(`Throttling WhatsApp sender ${from} (${totalHits} msgs in window)`);
      increment('sendam_webhook_events_total', { status: 'throttled' });
      if (totalHits === botMax + 1) {
        sendTextMessage(from, replies.rateLimited());
      }
      return res.status(200).send('EVENT_RECEIVED');
    }

    const options = message.id ? { jobId: message.id } : {};
    // Meta's inbound timestamp (unix seconds) is the source of truth for
    // per-sender message ordering — see queues/ordering.service.js. It's
    // preserved through the job data rather than relying on enqueue order,
    // since redelivered/out-of-order webhook events would otherwise be
    // ordered by arrival at this process instead of by what the customer
    // actually sent first.
    const providerTimestamp = message.timestamp ? Number(message.timestamp) * 1000 : undefined;
    await enqueue('whatsapp-inbound', 'message.received', {
      from,
      whatsappName,
      text: message.text?.body,
      mediaId: message.audio?.id || message.voice?.id,
      messageType: message.type,
      whatsappMessageId: message.id,
      providerTimestamp,
    }, options);
    increment('sendam_webhook_events_total', { status: 'enqueued' });
    if (claimedMessageId) {
      await prisma.processedMessage.updateMany({
        where: { messageId: claimedMessageId, status: 'claiming' },
        data: { status: 'queued', lastError: null },
      });
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    increment('sendam_webhook_events_total', { status: 'failed' });
    logger.error('webhook_processing_error', error);
    captureException(error, { source: 'webhook' });
    // Preserve a recoverable durable state. A later Meta delivery atomically
    // reclaims only failed rows; concurrent claiming/queued work is untouched.
    if (claimedMessageId) {
      try {
        await prisma.processedMessage.updateMany({
          where: { messageId: claimedMessageId, status: 'claiming' },
          data: { status: 'failed', lastError: String(error.message).slice(0, 500) },
        });
      } catch (cleanupError) {
        logger.error('Webhook delivery state recovery failed:', cleanupError);
        captureException(cleanupError, { source: 'webhook_cleanup' });
      }
    }
    if (!res.headersSent) return res.status(503).send('QUEUE_UNAVAILABLE');
  }
};

module.exports = {
  handleIncomingMessage,
};
