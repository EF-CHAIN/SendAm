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
  assert.equal(validateWebhookEnvelope(null).reason, 'Payload must be a non-null object');
  assert.equal(validateWebhookEnvelope(undefined).valid, false);
  assert.equal(validateWebhookEnvelope('string_payload').valid, false);

  assert.equal(validateWebhookEnvelope({ object: 'user' }).valid, false);
  assert.equal(
    validateWebhookEnvelope({ object: 'user' }).reason,
    'Root object must be whatsapp_business_account'
  );

  assert.equal(validateWebhookEnvelope({ object: 'whatsapp_business_account', entry: [] }).valid, false);
  assert.equal(
    validateWebhookEnvelope({ object: 'whatsapp_business_account', entry: [] }).reason,
    'entry must be a non-empty array'
  );

  assert.equal(
    validateWebhookEnvelope({ object: 'whatsapp_business_account', entry: 'not_an_array' }).valid,
    false
  );
  assert.equal(
    validateWebhookEnvelope({ object: 'whatsapp_business_account', entry: 'not_an_array' }).reason,
    'entry must be a non-empty array'
  );
});

test('validateWebhookEnvelope rejects entry exceeding max length or malformed changes', () => {
  // entry array exceeds maximum length of 50
  const tooManyEntries = {
    object: 'whatsapp_business_account',
    entry: Array.from({ length: 51 }, () => ({ changes: [{ value: {} }] })),
  };
  const resTooMany = validateWebhookEnvelope(tooManyEntries);
  assert.equal(resTooMany.valid, false);
  assert.equal(resTooMany.reason, 'entry array exceeds maximum length of 50');

  // entry item is null or non-object
  const nullEntry = {
    object: 'whatsapp_business_account',
    entry: [null],
  };
  const resNullEntry = validateWebhookEnvelope(nullEntry);
  assert.equal(resNullEntry.valid, false);
  assert.equal(resNullEntry.reason, 'entry must contain a non-empty changes array');

  // entry missing changes array
  const missingChanges = {
    object: 'whatsapp_business_account',
    entry: [{ id: '123' }],
  };
  const resMissingChanges = validateWebhookEnvelope(missingChanges);
  assert.equal(resMissingChanges.valid, false);
  assert.equal(resMissingChanges.reason, 'entry must contain a non-empty changes array');

  // entry has empty changes array
  const emptyChanges = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [] }],
  };
  const resEmptyChanges = validateWebhookEnvelope(emptyChanges);
  assert.equal(resEmptyChanges.valid, false);
  assert.equal(resEmptyChanges.reason, 'entry must contain a non-empty changes array');

  // entry has non-array changes
  const nonArrayChanges = {
    object: 'whatsapp_business_account',
    entry: [{ changes: 'not_an_array' }],
  };
  const resNonArrayChanges = validateWebhookEnvelope(nonArrayChanges);
  assert.equal(resNonArrayChanges.valid, false);
  assert.equal(resNonArrayChanges.reason, 'entry must contain a non-empty changes array');
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

  // Non-object or null
  assert.equal(validateInboundMessage(null).valid, false);
  assert.equal(validateInboundMessage(null).reason, 'Message must be a non-null object');
  assert.equal(validateInboundMessage('invalid').valid, false);

  // Missing or invalid id
  assert.equal(validateInboundMessage({ ...validText, id: '' }).valid, false);
  assert.equal(
    validateInboundMessage({ ...validText, id: '' }).reason,
    'Message id must be a valid non-empty string (<= 256 chars)'
  );
  assert.equal(validateInboundMessage({ ...validText, id: '   ' }).valid, false);
  assert.equal(validateInboundMessage({ ...validText, id: 12345 }).valid, false);
  assert.equal(validateInboundMessage({ ...validText, id: 'a'.repeat(257) }).valid, false);

  // Missing or invalid from
  assert.equal(validateInboundMessage({ ...validText, from: '' }).valid, false);
  assert.equal(
    validateInboundMessage({ ...validText, from: '' }).reason,
    'Message from must be a valid sender phone string'
  );
  assert.equal(validateInboundMessage({ ...validText, from: '   ' }).valid, false);
  assert.equal(validateInboundMessage({ ...validText, from: 2348012345678 }).valid, false);

  // Malformed timestamp
  assert.equal(validateInboundMessage({ ...validText, timestamp: '' }).valid, false);
  assert.equal(
    validateInboundMessage({ ...validText, timestamp: '' }).reason,
    'Message timestamp must be a valid unix timestamp'
  );
  assert.equal(validateInboundMessage({ ...validText, timestamp: 'not_a_number' }).valid, false);
  assert.equal(
    validateInboundMessage({ ...validText, timestamp: 'not_a_number' }).reason,
    'Message timestamp must be a valid unix timestamp'
  );

  // Optional timestamp null/undefined should be allowed
  assert.equal(validateInboundMessage({ ...validText, timestamp: null }).valid, true);
  assert.equal(validateInboundMessage({ ...validText, timestamp: undefined }).valid, true);
});

test('validateInboundMessage rejects unexpected nesting and wrong types for payload variants', () => {
  const baseMessage = {
    id: 'wamid.12345',
    from: '2348012345678',
    timestamp: '1700000000',
  };

  // Missing or non-string message type
  assert.equal(validateInboundMessage({ ...baseMessage, type: null }).valid, false);
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: null }).reason,
    'Message type must be a string'
  );
  assert.equal(validateInboundMessage({ ...baseMessage, type: 42 }).valid, false);

  // Unsupported message type
  assert.equal(validateInboundMessage({ ...baseMessage, type: 'video' }).valid, false);
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: 'video' }).reason,
    'Unsupported message type: video'
  );

  // Text message with missing text object
  assert.equal(validateInboundMessage({ ...baseMessage, type: 'text', text: null }).valid, false);
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: 'text', text: null }).reason,
    'Text message must contain text.body string'
  );

  // Text message with text.body as non-string (wrong type)
  assert.equal(validateInboundMessage({ ...baseMessage, type: 'text', text: { body: 12345 } }).valid, false);
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: 'text', text: { body: 12345 } }).reason,
    'Text message must contain text.body string'
  );

  // Text message with text.body exceeding maximum length of 4096
  const longBody = 'x'.repeat(4097);
  const resLongBody = validateInboundMessage({ ...baseMessage, type: 'text', text: { body: longBody } });
  assert.equal(resLongBody.valid, false);
  assert.equal(resLongBody.reason, 'Text body exceeds maximum length of 4096');

  // Audio message with missing audio object
  assert.equal(validateInboundMessage({ ...baseMessage, type: 'audio', audio: null }).valid, false);
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: 'audio', audio: null }).reason,
    'Audio message must contain audio.id string'
  );

  // Audio message with non-string audio.id (wrong type)
  assert.equal(validateInboundMessage({ ...baseMessage, type: 'audio', audio: { id: 999 } }).valid, false);
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: 'audio', audio: { id: 999 } }).reason,
    'Audio message must contain audio.id string'
  );

  // Voice message with missing voice object
  assert.equal(validateInboundMessage({ ...baseMessage, type: 'voice', voice: null }).valid, false);
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: 'voice', voice: null }).reason,
    'Voice message must contain voice.id string'
  );

  // Voice message with non-string voice.id (wrong type)
  assert.equal(validateInboundMessage({ ...baseMessage, type: 'voice', voice: { id: {} } }).valid, false);
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: 'voice', voice: { id: {} } }).reason,
    'Voice message must contain voice.id string'
  );

  // Valid audio and voice messages
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: 'audio', audio: { id: 'media-audio-123' } }).valid,
    true
  );
  assert.equal(
    validateInboundMessage({ ...baseMessage, type: 'voice', voice: { id: 'media-voice-123' } }).valid,
    true
  );
});

test('validateStatusEntry validates callback required fields', () => {
  const validStatus = {
    id: 'wamid.12345',
    status: 'delivered',
    timestamp: '1700000000',
  };
  assert.equal(validateStatusEntry(validStatus).valid, true);

  // Non-object status entry
  assert.equal(validateStatusEntry(null).valid, false);
  assert.equal(validateStatusEntry(null).reason, 'Status entry must be a non-null object');
  assert.equal(validateStatusEntry('invalid').valid, false);

  // Missing or invalid id
  assert.equal(validateStatusEntry({ ...validStatus, id: '' }).valid, false);
  assert.equal(validateStatusEntry({ ...validStatus, id: '' }).reason, 'Status entry id must be a non-empty string');
  assert.equal(validateStatusEntry({ ...validStatus, id: '   ' }).valid, false);
  assert.equal(validateStatusEntry({ ...validStatus, id: 12345 }).valid, false);

  // Invalid or non-string status
  assert.equal(validateStatusEntry({ ...validStatus, status: 'invalid_status' }).valid, false);
  assert.equal(
    validateStatusEntry({ ...validStatus, status: 'invalid_status' }).reason,
    'Status must be one of: sent, delivered, read, failed'
  );
  assert.equal(validateStatusEntry({ ...validStatus, status: null }).valid, false);

  // Supported status values (case-insensitive check)
  for (const s of ['sent', 'delivered', 'read', 'failed', 'SENT', 'Delivered']) {
    assert.equal(validateStatusEntry({ ...validStatus, status: s }).valid, true);
  }

  // Missing, empty or non-numeric timestamp
  assert.equal(validateStatusEntry({ ...validStatus, timestamp: null }).valid, false);
  assert.equal(validateStatusEntry({ ...validStatus, timestamp: null }).reason, 'Status timestamp must be a valid timestamp');
  assert.equal(validateStatusEntry({ ...validStatus, timestamp: '' }).valid, false);
  assert.equal(validateStatusEntry({ ...validStatus, timestamp: 'abc' }).valid, false);
});
