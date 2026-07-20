const { test } = require('node:test');
const assert = require('node:assert/strict');

// crypto.service (pulled in transitively via config) validates the
// encryption key at require-time, so set it before importing.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const { createAiClient, aiClient } = require('../src/services/aiClient');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const enabledConfig = { enabled: true, serviceUrl: 'http://ai.internal', secret: 's' };

const respondWith = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('default client is disabled when env is unset and returns null without a network call', async () => {
  assert.equal(aiClient.enabled, false);
  assert.equal(await aiClient.decodeToPaymentIntent('send 5k to @ada', 'u_1'), null);
});

test('flag on but URL/secret missing still means disabled', async () => {
  const client = createAiClient({
    aiConfig: { enabled: true, serviceUrl: undefined, secret: undefined },
    logger: silentLogger,
  });
  assert.equal(client.enabled, false);
});

test('maps a SEND decode into the regex parser shape', async () => {
  const client = createAiClient({
    aiConfig: enabledConfig,
    fetchImpl: respondWith({
      intent: 'SEND',
      chain: null,
      amount: '5000',
      asset: 'usdc',
      recipient: '@ada',
      confidence: 0.9,
    }),
    logger: silentLogger,
  });

  const intent = await client.decodeToPaymentIntent('abeg send 5k give ada', 'u_1');
  assert.deepEqual(intent, { amount: '5000', asset: 'USDC', recipient: '@ada' });
});

test('a null asset stays undefined so the orchestrator picks the native asset', async () => {
  const client = createAiClient({
    aiConfig: enabledConfig,
    fetchImpl: respondWith({
      intent: 'SEND',
      chain: null,
      amount: '2000',
      asset: null,
      recipient: 'mama',
      confidence: 0.9,
    }),
    logger: silentLogger,
  });

  const intent = await client.decodeToPaymentIntent('x', 'u_1');
  assert.equal(intent.asset, undefined);
});

test('UNKNOWN and non-SEND intents degrade to null', async () => {
  for (const decoded of [
    { intent: 'UNKNOWN', chain: null, amount: null, asset: null, recipient: null, confidence: 0 },
    { intent: 'BALANCE', chain: null, amount: null, asset: null, recipient: null, confidence: 0.9 },
    { intent: 'SEND', chain: null, amount: null, asset: null, recipient: '@ada', confidence: 0.9 }, // no amount
    { intent: 'SEND', chain: null, amount: '5', asset: null, recipient: null, confidence: 0.9 }, // no recipient
  ]) {
    const client = createAiClient({ aiConfig: enabledConfig, fetchImpl: respondWith(decoded), logger: silentLogger });
    assert.equal(await client.decodeToPaymentIntent('x', 'u_1'), null, JSON.stringify(decoded));
  }
});

test('an unreachable service degrades to null, never throws', async () => {
  const client = createAiClient({
    aiConfig: enabledConfig,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    logger: silentLogger,
  });
  assert.equal(await client.decodeToPaymentIntent('send 5k to @ada', 'u_1'), null);
});

test('a non-2xx response degrades to null', async () => {
  const client = createAiClient({
    aiConfig: enabledConfig,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ code: 'NOT_CONFIGURED' }) }),
    logger: silentLogger,
  });
  assert.equal(await client.decodeToPaymentIntent('x', 'u_1'), null);
});
