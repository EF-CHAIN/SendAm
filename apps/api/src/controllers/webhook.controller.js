const { sendTextMessage } = require('../services/whatsapp.service');
const { replies } = require('../services/agent/replies');
const { consume } = require('../services/rateLimit.service');
const config = require('../config/env');
const logger = require('../utils/logger');
const { enqueue } = require('../queues/queue.service');
const prisma = require('../common/prisma');
const { increment } = require('../observability/metrics');
const { captureException } = require('../observability/errors');

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
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.status(200).send('EVENT_RECEIVED');

    const value = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || !['text', 'audio', 'voice'].includes(message.type)) {
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
          logger.info(`Skipping duplicate WhatsApp message ${message.id}`);
          increment('sendam_webhook_events_total', { status: 'duplicate' });
          return;
        }
      }
    }

    const from = message.from;
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
    await enqueue('whatsapp-inbound', 'message.received', {
      from,
      whatsappName,
      text: message.text?.body,
      mediaId: message.audio?.id || message.voice?.id,
      messageType: message.type,
      whatsappMessageId: message.id,
    }, options);
    increment('sendam_webhook_events_total', { status: 'enqueued' });
  } catch (error) {
    increment('sendam_webhook_events_total', { status: 'failed' });
    logger.error('webhook_processing_error', error);
    captureException(error, { source: 'webhook' });
  }
};

module.exports = {
  handleIncomingMessage,
};
