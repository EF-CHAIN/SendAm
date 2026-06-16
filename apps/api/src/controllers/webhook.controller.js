const { processMessage } = require('../services/agent/handler');
const { sendTextMessage } = require('../services/whatsapp.service');
const { replies } = require('../services/agent/replies');
const ProcessedMessage = require('../models/ProcessedMessage');
const logger = require('../utils/logger');

/**
 * Transport adapter for the WhatsApp Cloud API webhook. Its only jobs are
 * acknowledging the event quickly, extracting the inbound text message, and
 * handing it to the agent. All conversation logic lives in services/agent.
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
    if (!message || message.type !== 'text') return;

    // Idempotency: Meta redelivers un-acked events, so dedup on message id
    // before doing anything with side effects. A duplicate insert throws on
    // the unique index and we bail out without reprocessing.
    if (message.id) {
      try {
        await ProcessedMessage.create({ messageId: message.id });
      } catch (err) {
        if (err.code === 11000) {
          logger.info(`Skipping duplicate WhatsApp message ${message.id}`);
          return;
        }
        throw err;
      }
    }

    const from = message.from;
    const whatsappName = value?.contacts?.[0]?.profile?.name || '';

    processMessage(from, whatsappName, message.text.body).catch((err) => {
      logger.error(`Error processing command for ${from}:`, err);
      sendTextMessage(from, replies.genericError(err.message));
    });
  } catch (error) {
    logger.error('Webhook processing error:', error);
  }
};

module.exports = {
  handleIncomingMessage,
};
