const { registerProcessor } = require('../queues/queue.service');
const { processMessage } = require('../whatsapp/assistant.service');
const { processVoiceMessage } = require('../voice/voice.service');
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

  logger.info('WhatsApp queue processor registered');
};

module.exports = {
  registerWhatsAppJobs,
};
