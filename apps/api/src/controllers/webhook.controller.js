const { sendTextMessage } = require('../services/whatsapp.service');
const { replies } = require('../services/agent/replies');
const { consume } = require('../services/rateLimit.service');
const config = require('../config/env');
const logger = require('../utils/logger');
const { enqueue } = require('../queues/queue.service');
const prisma = require('../common/prisma');

/**
 * Transport adapter for the WhatsApp Cloud API webhook. Its only jobs are
 * acknowledging the event quickly, extracting the inbound WhatsApp message,
 * and queueing background work. All conversation/payment logic lives outside
 * the webhook request path so Meta retries never duplicate money movement.
 *
 * The POST signature is verified upstream (verifyWhatsappSignature middleware).
 */
const handleIncomingMessage = async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || !['text', 'audio', 'voice'].includes(message.type)) return;

    // Idempotency: Meta redelivers un-acked events, so dedup on message id
    // before doing anything with side effects. A duplicate insert throws on
    // the unique index and we bail out without reprocessing.
    if (message.id) {
      try {
        await prisma.processedMessage.create({ data: { messageId: message.id } });
      } catch (err) {
        if (err.code === 'P2002') {
          logger.info(`Skipping duplicate WhatsApp message ${message.id}`);
          return;
        }
        throw err;
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
      if (totalHits === botMax + 1) {
        sendTextMessage(from, replies.rateLimited());
      }
      return;
    }

    await enqueue('whatsapp-inbound', 'message.received', {
      from,
      whatsappName,
      text: message.text?.body,
      mediaId: message.audio?.id || message.voice?.id,
      messageType: message.type,
      whatsappMessageId: message.id,
    });
  } catch (error) {
    logger.error('Webhook processing error:', error);
  }
};

module.exports = {
  handleIncomingMessage,
};
