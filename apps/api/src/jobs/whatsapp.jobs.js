const { registerProcessor } = require('../queues/queue.service');
const { processMessage } = require('../whatsapp/assistant.service');
const { processVoiceMessage } = require('../voice/voice.service');
const { retryOutboundNotification } = require('../services/whatsapp.service');
const logger = require('../utils/logger');

const registerWhatsAppJobs = () => {
  registerProcessor('whatsapp-inbound', async (job) => {
    const { from, whatsappName, text, mediaId, messageType, whatsappMessageId } = job.data;

    if (messageType === 'audio' || messageType === 'voice') {
      await processVoiceMessage({ phoneNumber: from, whatsappName, mediaId, whatsappMessageId });
      return;
    }

    await processMessage(from, whatsappName, text);
  });

  registerProcessor('whatsapp-outbound-retry', async (job) => {
    const { notificationId, to, body, attempts = 0 } = job.data;
    if (!notificationId) return;

    await retryOutboundNotification({
      notificationId,
      to,
      body,
      attempts,
    });
  });

  logger.info('WhatsApp queue processor registered');
};

module.exports = {
  registerWhatsAppJobs,
};
