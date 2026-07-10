const { test } = require('node:test');
const assert = require('node:assert/strict');

// crypto.service (pulled in transitively) validates the encryption key at
// require-time, so set it before importing. PAYMASTER_SERVICE_URL is left
// unset deliberately — this file tests the default, unconfigured behavior.
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { sponsorTransaction } = require('../src/services/paymaster.service');

test('sponsorTransaction degrades gracefully when unconfigured, without making a network call', async () => {
  const result = await sponsorTransaction({ from: '0xfrom', to: '0xto', amount: '1', chain: 'lisk' });
  assert.deepEqual(result, { sponsored: false, reason: 'Paymaster not configured' });
});

test('sponsorTransaction never throws for the caller to handle', async () => {
  await assert.doesNotReject(sponsorTransaction({ from: '0xfrom', to: '0xto', amount: '1', chain: 'lisk' }));
});
