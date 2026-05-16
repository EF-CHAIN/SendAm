const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');

const sendTextMessage = async (to, body) => {
  try {
    const url = `https://graph.facebook.com/v19.0/${config.whatsapp.phoneNumberId}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: {
        preview_url: false,
        body: body,
      }
    };

    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${config.whatsapp.token}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    logger.error('WhatsApp API Error:', error.response?.data || error.message);
    // Don't throw to prevent webhook failures when whatsapp is misconfigured
    return null;
  }
};

module.exports = {
  sendTextMessage
};
