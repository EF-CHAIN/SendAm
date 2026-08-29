'use strict';

/**
 * Builders for WhatsApp Cloud API webhook payloads.
 *
 * Shaped to match what Meta actually posts (see webhook.controller.js, which
 * reads entry[0].changes[0].value.messages[0]) so a load run drives the same
 * parsing and dedup branches production does.
 */

const textMessage = ({ messageId, from, text, profileName = 'Load Test' }) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'load-test-entry',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550000000', phone_number_id: 'load-test-phone-id' },
        contacts: [{ profile: { name: profileName }, wa_id: from.replace('+', '') }],
        messages: [{
          from: from.replace('+', ''),
          id: messageId,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: text },
        }],
      },
    }],
  }],
});

/**
 * Phone numbers in a reserved-looking range, so a run against a shared staging
 * environment is easy to identify and clean up afterwards.
 */
const syntheticSender = (index) => `+23480000${String(index).padStart(5, '0')}`;

const uniqueMessageId = (prefix, index) => `wamid.load-${prefix}-${process.pid}-${Date.now()}-${index}`;

/** A plausible session: greeting, balance check, then a small transfer. */
const SEQUENCE_TEMPLATES = [
  'hi',
  'balance',
  'send 1 XLM to +2348000000001',
  'history',
];

module.exports = { textMessage, syntheticSender, uniqueMessageId, SEQUENCE_TEMPLATES };
