const config = require('../config/env');
const { postMeta, sendMetaMessage } = require('../services/whatsappMedia');

const sendVoiceReceipt = async ({ phoneNumber, transaction, label, ledgerConfirmed, fetchImpl = fetch,
  upload = postMeta, send = sendMetaMessage, signal = AbortSignal.timeout(4800) }) => {
  const apiKey = process.env.DEEPGRAM_TTS_API_KEY;
  if (!apiKey || config.messageTransport !== 'meta') return;
  if (transaction.status !== 'success' && !(ledgerConfirmed && transaction.status === 'pending')) return;

  const amount = `${transaction.amount} ${transaction.asset}`;
  const recipient = !label || /^[GM][A-Z2-7]{55,68}$/.test(label) || /^\+?\d+$/.test(label)
    ? 'your recipient' : label.slice(0, 48);
  const response = await fetchImpl('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=opus&container=ogg', {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `Your payment of ${amount} to ${recipient} has been delivered on Stellar.` }),
    signal,
  });
  if (!response.ok) throw new Error(`Receipt speech synthesis returned ${response.status}`);

  const media = new FormData();
  media.set('messaging_product', 'whatsapp');
  const contentType = 'audio/ogg; codecs=opus';
  media.set('type', contentType);
  media.set('file', new Blob([await response.arrayBuffer()], { type: contentType }), 'receipt.ogg');
  const { id } = await upload('media', media, signal);
  if (!id) throw new Error('WhatsApp did not return a receipt media ID');
  await send(phoneNumber, 'audio', { id, voice: true }, signal);
};

module.exports = { sendVoiceReceipt };
