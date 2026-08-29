const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateWebhookEnvelope,
  validateInboundMessage,
  validateStatusEntry,
} = require('../src/whatsapp/webhook.validator');

test('validateWebhookEnvelope validates root object and entry structure', () => {
  const valid = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {} }] }],
  };
  assert.equal(validateWebhookEnvelope(valid).valid, true);

  assert.equal(validateWebhookEnvelope(null).valid, false);
  assert.equal(validateWebhookEnvelope({ object: 'user' }).valid, false);
  assert.equal(validateWebhookEnvelope({ object: 'whatsapp_business_account', entry: [] }).valid, false);
});

test('validateInboundMessage validates message fields and rejects malformed shapes', () => {
  const validText = {
    id: 'wamid.12345',
    from: '2348012345678',
    timestamp: '1700000000',
    type: 'text',
    text: { body: 'send 10 XLM' },
  };
  assert.equal(validateInboundMessage(validText).valid, true);

  assert.equal(validateInboundMessage({ ...validText, id: '' }).valid, false);
  assert.equal(validateInboundMessage({ ...validText, from: '' }).valid, false);
  assert.equal(validateInboundMessage({ ...validText, timestamp: '' }).valid, false);
  assert.equal(validateInboundMessage({ ...validText, type: 'text', text: null }).valid, false);
});

test('validateStatusEntry validates callback required fields', () => {
  const validStatus = {
    id: 'wamid.12345',
    status: 'delivered',
    timestamp: '1700000000',
  };
  assert.equal(validateStatusEntry(validStatus).valid, true);

  assert.equal(validateStatusEntry({ ...validStatus, status: 'invalid_status' }).valid, false);
  assert.equal(validateStatusEntry({ ...validStatus, id: '' }).valid, false);
});
