const axios = require('axios');
const config = require('../config/env');
const { sendTextMessage } = require('../services/whatsapp.service');
const { processMessage } = require('../whatsapp/assistant.service');
const prisma = require('../common/prisma');

const transcribeWithDeepgram = async (audioBuffer) => {
  if (!config.voice.deepgramApiKey) {
    throw new Error('Deepgram is not configured. Set DEEPGRAM_API_KEY.');
  }

  const response = await axios.post(
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
    audioBuffer,
    {
      headers: {
        Authorization: `Token ${config.voice.deepgramApiKey}`,
        'Content-Type': 'audio/ogg',
      },
      timeout: 60000,
    }
  );

  return response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
};

const downloadWhatsAppMedia = async (mediaId) => {
  if (!config.whatsapp.token) {
    throw new Error('WhatsApp token is not configured.');
  }

  const metadata = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.whatsapp.token}` },
    timeout: 30000,
  });

  const media = await axios.get(metadata.data.url, {
    headers: { Authorization: `Bearer ${config.whatsapp.token}` },
    responseType: 'arraybuffer',
    timeout: 60000,
  });

  return Buffer.from(media.data);
};

const processVoiceMessage = async ({ phoneNumber, whatsappName, mediaId, whatsappMessageId }) => {
  let user = await prisma.user.findUnique({ where: { phoneNumber } });
  if (!user) user = await prisma.user.create({ data: { phoneNumber, whatsappName } });

  const record = await prisma.voiceCommand.create({
    data: {
      userId: user.id,
      phoneNumber,
      whatsappMessageId,
      status: 'queued',
    },
  });

  try {
    await sendTextMessage(phoneNumber, 'Got your voice note. I am checking the payment details now.');
    const audio = await downloadWhatsAppMedia(mediaId);
    const transcript = await transcribeWithDeepgram(audio);

    await prisma.voiceCommand.update({
      where: { id: record.id },
      data: { transcript, status: 'transcribed' },
    });

    await processMessage(phoneNumber, whatsappName, transcript);
  } catch (error) {
    await prisma.voiceCommand.update({
      where: { id: record.id },
      data: { status: 'failed', error: error.message },
    });
    await sendTextMessage(phoneNumber, 'I could not read that voice note. Please try again or type the payment.');
  }
};

module.exports = {
  processVoiceMessage,
};
