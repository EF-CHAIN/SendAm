const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const { createSettlementClient, settlementClient } = require('../src/services/settlementClient');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const enabledConfig = { enabled: true, serviceUrl: 'http://settlement.internal', secret: 's' };

test('default client is disabled when env is unset; every call is a null no-op', async () => {
  assert.equal(settlementClient.enabled, false);
  assert.equal(await settlementClient.credit({ userId: 'u_1', chain: 'stellar', asset: 'USDC', amount: '100', idempotencyKey: 'k' }), null);
  assert.equal(await settlementClient.transfer({ fromUserId: 'u_1', toUserId: 'u_2', asset: 'USDC', amount: '1', idempotencyKey: 'k' }), null);
  assert.equal(await settlementClient.quote({ chain: 'stellar', asset: 'USDC', net: '100' }), null);
  assert.equal(await settlementClient.balances('u_1'), null);
});

test('passes the idempotency key through on mutations', async () => {
  let seen;
  const client = createSettlementClient({
    settlementConfig: enabledConfig,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 201, json: async () => ({ entryId: 'e_1', balance: '100' }) };
    },
    logger: silentLogger,
  });

  const result = await client.credit({ userId: 'u_1', chain: 'stellar', asset: 'USDC', amount: '100', idempotencyKey: 'api:tx_9' });
  assert.deepEqual(result, { entryId: 'e_1', balance: '100' });
  assert.match(seen.url, /\/credit$/);
  assert.equal(seen.options.headers['Idempotency-Key'], 'api:tx_9');
});

test('service errors degrade to null, never a throw', async () => {
  const client = createSettlementClient({
    settlementConfig: enabledConfig,
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ code: 'INSUFFICIENT_FUNDS' }) }),
    logger: silentLogger,
  });
  assert.equal(await client.transfer({ fromUserId: 'u_1', toUserId: 'u_2', asset: 'USDC', amount: '1', idempotencyKey: 'k' }), null);
});
