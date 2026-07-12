const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// crypto.service (pulled in transitively) validates the encryption key at
// require-time, so set it before importing. PAYMASTER_SERVICE_URL is left
// unset deliberately — this file tests the default, unconfigured behavior.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { sponsorTransaction, createPaymasterClient } = require('../src/services/paymaster.service');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test('sponsorTransaction degrades gracefully when unconfigured, without making a network call', async () => {
  const result = await sponsorTransaction({ from: '0xfrom', to: '0xto', amount: '1', chain: 'lisk' });
  assert.deepEqual(result, { sponsored: false, reason: 'Paymaster not configured' });
});

test('sponsorTransaction never throws for the caller to handle', async () => {
  await assert.doesNotReject(sponsorTransaction({ from: '0xfrom', to: '0xto', amount: '1', chain: 'lisk' }));
});

test('a URL without the HMAC secret still counts as unconfigured', async () => {
  const client = createPaymasterClient({
    paymasterConfig: { serviceUrl: 'http://paymaster.internal', secret: undefined },
    logger: silentLogger,
  });
  const result = await client.sponsorTransaction({ from: '0xfrom', to: '0xto', amount: '1', chain: 'lisk' });
  assert.deepEqual(result, { sponsored: false, reason: 'Paymaster not configured' });
});

test('a configured client signs the request body with the shared HMAC contract', async () => {
  let seen;
  const client = createPaymasterClient({
    paymasterConfig: { serviceUrl: 'http://paymaster.internal', secret: 'shared-secret' },
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 201, json: async () => ({ txHash: '0xhash' }) };
    },
    logger: silentLogger,
  });

  const result = await client.sponsorTransaction({ from: '0xfrom', to: '0xto', amount: '1', chain: 'lisk' });
  assert.deepEqual(result, { sponsored: true, txHash: '0xhash' });
  assert.equal(seen.url, 'http://paymaster.internal/sponsor');

  const expectedSignature = crypto.createHmac('sha256', 'shared-secret').update(seen.options.body).digest('hex');
  assert.equal(seen.options.headers['X-Sendam-Signature'], expectedSignature);
  assert.ok(seen.options.headers['X-Sendam-Timestamp']);
});

test('an unreachable paymaster degrades to {sponsored:false, reason: unreachable}', async () => {
  const client = createPaymasterClient({
    paymasterConfig: { serviceUrl: 'http://paymaster.internal', secret: 's' },
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    logger: silentLogger,
  });
  const result = await client.sponsorTransaction({ from: '0xfrom', to: '0xto', amount: '1', chain: 'lisk' });
  assert.deepEqual(result, { sponsored: false, reason: 'Paymaster unreachable' });
});
