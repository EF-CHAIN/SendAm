'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateWebhookEnvelope,
  validateInboundMessage,
  validateStatusEntry,
} = require('../src/whatsapp/webhook.validator');

describe('whatsapp/webhook.validator', () => {
  describe('validateWebhookEnvelope', () => {
    it('accepts valid envelope structure', () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '123456',
            changes: [{ field: 'messages', value: {} }],
          },
        ],
      };
      const result = validateWebhookEnvelope(payload);
      assert.deepEqual(result, { valid: true });
    });

    it('rejects null, non-object, or empty payloads', () => {
      assert.equal(validateWebhookEnvelope(null).valid, false);
      assert.equal(validateWebhookEnvelope('string').valid, false);
      assert.equal(validateWebhookEnvelope(123).valid, false);
    });

    it('rejects invalid root object name', () => {
      const payload = {
        object: 'facebook_page',
        entry: [{ changes: [{}] }],
      };
      const res = validateWebhookEnvelope(payload);
      assert.equal(res.valid, false);
      assert.equal(res.reason, 'Root object must be whatsapp_business_account');
    });

    it('rejects missing or empty entry array', () => {
      assert.equal(validateWebhookEnvelope({ object: 'whatsapp_business_account', entry: [] }).valid, false);
      assert.equal(validateWebhookEnvelope({ object: 'whatsapp_business_account' }).valid, false);
    });

    it('rejects entry array exceeding max length of 50', () => {
      const entries = Array.from({ length: 51 }, () => ({ changes: [{}] }));
      const res = validateWebhookEnvelope({ object: 'whatsapp_business_account', entry: entries });
      assert.equal(res.valid, false);
      assert.equal(res.reason, 'entry array exceeds maximum length of 50');
    });

    it('rejects entry without non-empty changes array or invalid entry element', () => {
      const resMissingChanges = validateWebhookEnvelope({
        object: 'whatsapp_business_account',
        entry: [{ id: '123' }],
      });
      assert.equal(resMissingChanges.valid, false);
      assert.equal(resMissingChanges.reason, 'entry must contain a non-empty changes array');

      const resEmptyChanges = validateWebhookEnvelope({
        object: 'whatsapp_business_account',
        entry: [{ changes: [] }],
      });
      assert.equal(resEmptyChanges.valid, false);

      const resNullEntry = validateWebhookEnvelope({
        object: 'whatsapp_business_account',
        entry: [null],
      });
      assert.equal(resNullEntry.valid, false);
    });
  });

  describe('validateInboundMessage', () => {
    it('accepts valid text message', () => {
      const message = {
        id: 'wamid.HBgL...',
        from: '2348012345678',
        timestamp: '1710000000',
        type: 'text',
        text: { body: 'hello' },
      };
      assert.deepEqual(validateInboundMessage(message), { valid: true });
    });

    it('accepts valid audio and voice messages', () => {
      const audioMsg = {
        id: 'wamid.HBgL...',
        from: '2348012345678',
        type: 'audio',
        audio: { id: 'media-audio-123' },
      };
      assert.deepEqual(validateInboundMessage(audioMsg), { valid: true });

      const voiceMsg = {
        id: 'wamid.HBgL...',
        from: '2348012345678',
        type: 'voice',
        voice: { id: 'media-voice-123' },
      };
      assert.deepEqual(validateInboundMessage(voiceMsg), { valid: true });
    });

    it('rejects null or non-object message', () => {
      assert.equal(validateInboundMessage(null).valid, false);
      assert.equal(validateInboundMessage(undefined).valid, false);
      assert.equal(validateInboundMessage('not-an-object').valid, false);
    });

    it('rejects missing or malformed message id', () => {
      const resMissing = validateInboundMessage({ from: '234...', type: 'text', text: { body: 'hi' } });
      assert.equal(resMissing.valid, false);
      assert.equal(resMissing.reason, 'Message id must be a valid non-empty string (<= 256 chars)');

      const resEmpty = validateInboundMessage({ id: '   ', from: '234...', type: 'text', text: { body: 'hi' } });
      assert.equal(resEmpty.valid, false);

      const resTooLong = validateInboundMessage({ id: 'a'.repeat(257), from: '234...', type: 'text', text: { body: 'hi' } });
      assert.equal(resTooLong.valid, false);
    });

    it('rejects missing or empty sender phone string', () => {
      const resNoFrom = validateInboundMessage({ id: 'wamid.1', from: '', type: 'text', text: { body: 'hi' } });
      assert.equal(resNoFrom.valid, false);
      assert.equal(resNoFrom.reason, 'Message from must be a valid sender phone string');

      const resMissingFrom = validateInboundMessage({ id: 'wamid.1', type: 'text', text: { body: 'hi' } });
      assert.equal(resMissingFrom.valid, false);
      assert.equal(resMissingFrom.reason, 'Message from must be a valid sender phone string');
    });

    it('rejects non-numeric timestamps when timestamp is present', () => {
      const resBadTimestamp = validateInboundMessage({
        id: 'wamid.1',
        from: '2348012345678',
        timestamp: 'invalid-unix-epoch',
        type: 'text',
        text: { body: 'hi' },
      });
      assert.equal(resBadTimestamp.valid, false);
      assert.equal(resBadTimestamp.reason, 'Message timestamp must be a valid unix timestamp');
    });

    it('rejects unsupported or non-string message types', () => {
      const resNonString = validateInboundMessage({
        id: 'wamid.1',
        from: '2348012345678',
        type: 123,
      });
      assert.equal(resNonString.valid, false);
      assert.equal(resNonString.reason, 'Message type must be a string');

      const resUnsupported = validateInboundMessage({
        id: 'wamid.1',
        from: '2348012345678',
        type: 'unknown_custom_type',
      });
      assert.equal(resUnsupported.valid, false);
      assert.equal(resUnsupported.reason, 'Unsupported message type: unknown_custom_type');
    });

    it('rejects text messages missing text.body or exceeding max body length', () => {
      const resNoBody = validateInboundMessage({
        id: 'wamid.1',
        from: '2348012345678',
        type: 'text',
        text: {},
      });
      assert.equal(resNoBody.valid, false);
      assert.equal(resNoBody.reason, 'Text message must contain text.body string');

      const resBodyTooLong = validateInboundMessage({
        id: 'wamid.1',
        from: '2348012345678',
        type: 'text',
        text: { body: 'a'.repeat(4097) },
      });
      assert.equal(resBodyTooLong.valid, false);
      assert.equal(resBodyTooLong.reason, 'Text body exceeds maximum length of 4096');
    });

    it('rejects audio and voice messages missing media ids', () => {
      const resNoAudioId = validateInboundMessage({
        id: 'wamid.1',
        from: '2348012345678',
        type: 'audio',
        audio: {},
      });
      assert.equal(resNoAudioId.valid, false);
      assert.equal(resNoAudioId.reason, 'Audio message must contain audio.id string');

      const resNoVoiceId = validateInboundMessage({
        id: 'wamid.1',
        from: '2348012345678',
        type: 'voice',
        voice: {},
      });
      assert.equal(resNoVoiceId.valid, false);
      assert.equal(resNoVoiceId.reason, 'Voice message must contain voice.id string');
    });
  });

  describe('validateStatusEntry', () => {
    it('accepts valid status entries (sent, delivered, read, failed)', () => {
      const statuses = ['sent', 'delivered', 'read', 'failed'];
      for (const status of statuses) {
        const res = validateStatusEntry({
          id: 'wamid.status.1',
          status,
          timestamp: '1710000000',
        });
        assert.deepEqual(res, { valid: true });
      }
    });

    it('rejects null, non-object, or empty status entries', () => {
      assert.equal(validateStatusEntry(null).valid, false);
      assert.equal(validateStatusEntry('delivered').valid, false);
    });

    it('rejects missing or empty status entry id', () => {
      const res = validateStatusEntry({ status: 'delivered', timestamp: '1710000000' });
      assert.equal(res.valid, false);
      assert.equal(res.reason, 'Status entry id must be a non-empty string');
    });

    it('rejects invalid or unsupported status values', () => {
      const res = validateStatusEntry({
        id: 'wamid.1',
        status: 'pending_confirmation',
        timestamp: '1710000000',
      });
      assert.equal(res.valid, false);
      assert.equal(res.reason, 'Status must be one of: sent, delivered, read, failed');
    });

    it('rejects missing or non-numeric status timestamp', () => {
      const resMissing = validateStatusEntry({
        id: 'wamid.1',
        status: 'delivered',
      });
      assert.equal(resMissing.valid, false);
      assert.equal(resMissing.reason, 'Status timestamp must be a valid timestamp');

      const resBad = validateStatusEntry({
        id: 'wamid.1',
        status: 'delivered',
        timestamp: 'not-a-number',
      });
      assert.equal(resBad.valid, false);
    });
  });
});
