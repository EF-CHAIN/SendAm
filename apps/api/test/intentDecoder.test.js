const { test } = require('node:test');
const assert = require('node:assert/strict');

// crypto.service (pulled in transitively) validates the encryption key at
// require-time, so set it before importing.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const PromptTemplate = require('../src/models/PromptTemplate');
const { decodeIntent, isConfident, CONFIDENCE_THRESHOLD } = require('../src/services/agent/intentDecoder.service');
const { mapDecodedToIntent } = require('../src/services/agent/handler');

// --- isConfident: pure logic, no network involved ---

test('isConfident rejects null/undefined', () => {
  assert.equal(isConfident(null), false);
  assert.equal(isConfident(undefined), false);
});

test('isConfident rejects a non-numeric confidence', () => {
  assert.equal(isConfident({ confidence: 'high' }), false);
});

test(`isConfident accepts exactly the threshold (${CONFIDENCE_THRESHOLD})`, () => {
  assert.equal(isConfident({ confidence: CONFIDENCE_THRESHOLD }), true);
});

test('isConfident rejects just below the threshold', () => {
  assert.equal(isConfident({ confidence: CONFIDENCE_THRESHOLD - 0.01 }), false);
});

// --- decodeIntent: degrades gracefully without ever hitting the network ---

test('decodeIntent returns null (not a throw) when no prompt is seeded', async () => {
  PromptTemplate.findOne = () => ({ sort: async () => null });
  const result = await decodeIntent('send 5 xlm to ada please');
  assert.equal(result, null);
});

test('decodeIntent returns null if the prompt lookup itself throws', async () => {
  PromptTemplate.findOne = () => { throw new Error('Mongo unavailable'); };
  const result = await decodeIntent('send 5 xlm to ada please');
  assert.equal(result, null);
});

// --- mapDecodedToIntent: shape translation into the same {type, payload}
// the regex parser produces, so a decoded message re-enters the exact same
// dispatch table (and guardrails) a typed command would ---

test('maps a decoded SEND with amount and recipient', () => {
  const result = mapDecodedToIntent({ intent: 'SEND', chain: 'stellar', amount: '5', asset: 'XLM', recipient: 'ada', confidence: 0.9 });
  assert.deepEqual(result, { type: 'SEND', payload: { amount: '5', asset: 'XLM', recipient: 'ada' } });
});

test('a decoded SEND missing amount or recipient maps to UNKNOWN, not a guess', () => {
  assert.deepEqual(
    mapDecodedToIntent({ intent: 'SEND', chain: null, amount: null, asset: null, recipient: 'ada', confidence: 0.9 }),
    { type: 'UNKNOWN', payload: null }
  );
  assert.deepEqual(
    mapDecodedToIntent({ intent: 'SEND', chain: null, amount: '5', asset: null, recipient: null, confidence: 0.9 }),
    { type: 'UNKNOWN', payload: null }
  );
});

test('a decoded SEND with no asset defaults from chain, uppercased', () => {
  const lisk = mapDecodedToIntent({ intent: 'SEND', chain: 'lisk', amount: '0.01', asset: null, recipient: '0xabc', confidence: 0.9 });
  assert.equal(lisk.payload.asset, 'ETH');

  const stellar = mapDecodedToIntent({ intent: 'SEND', chain: 'stellar', amount: '5', asset: null, recipient: 'ada', confidence: 0.9 });
  assert.equal(stellar.payload.asset, 'XLM');
});

test('maps simple no-payload intents straight through', () => {
  assert.equal(mapDecodedToIntent({ intent: 'BALANCE', chain: null, amount: null, asset: null, recipient: null, confidence: 0.9 }).type, 'BALANCE');
  assert.equal(mapDecodedToIntent({ intent: 'CREATE_WALLET', chain: null, amount: null, asset: null, recipient: null, confidence: 0.9 }).type, 'CREATE_WALLET');
  assert.equal(mapDecodedToIntent({ intent: 'LIST_CONTACTS', chain: null, amount: null, asset: null, recipient: null, confidence: 0.9 }).type, 'LIST_CONTACTS');
  assert.equal(mapDecodedToIntent({ intent: 'HELP', chain: null, amount: null, asset: null, recipient: null, confidence: 0.9 }).type, 'HELP');
});

test('an UNKNOWN (or anything unrecognized) maps to UNKNOWN', () => {
  assert.deepEqual(mapDecodedToIntent({ intent: 'UNKNOWN' }), { type: 'UNKNOWN', payload: null });
  assert.deepEqual(mapDecodedToIntent({ intent: 'SOMETHING_NEW' }), { type: 'UNKNOWN', payload: null });
});
