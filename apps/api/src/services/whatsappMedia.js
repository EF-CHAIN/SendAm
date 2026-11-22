const config = require('../config/env');

const postMeta = async (endpoint, body, signal) => {
  const version = config.whatsapp.graphApiVersion || 'v23.0';
  const response = await fetch(
    `https://graph.facebook.com/${version}/${config.whatsapp.phoneNumberId}/${endpoint}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
      signal,
    },
  );
  if (!response.ok) throw new Error(`WhatsApp ${endpoint} returned ${response.status}`);
  return response.json();
};

const sendMetaMessage = (to, type, content, signal) => postMeta('messages', {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: to.replace(/^\+/, ''),
  type,
  [type]: content,
}, signal);

module.exports = { postMeta, sendMetaMessage };
