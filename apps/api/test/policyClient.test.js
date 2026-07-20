const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const { createPolicyClient, policyClient } = require('../src/services/policyClient');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const enabledConfig = { enabled: true, serviceUrl: 'http://policy.internal', secret: 's' };

test('default client is disabled when env is unset; checkPolicy is null (local fallback)', async () => {
  assert.equal(policyClient.enabled, false);
  assert.equal(await policyClient.checkPolicy({ userId: 'u_1', amount: '100' }), null);
});

test('returns the service verdict when it answers', async () => {
  const client = createPolicyClient({
    policyConfig: enabledConfig,
    fetchImpl: async (url, options) => {
      assert.match(url, /\/policy\/check$/);
      const body = JSON.parse(options.body);
      assert.equal(body.userId, 'u_1');
      assert.equal(body.amount, '5000');
      return { ok: true, status: 200, json: async () => ({ allowed: false, reason: 'daily limit', riskScore: 55 }) };
    },
    logger: silentLogger,
  });

  const verdict = await client.checkPolicy({ userId: 'u_1', amount: 5000, routeType: 'domestic', destinationCountry: 'NG' });
  assert.deepEqual(verdict, { allowed: false, reason: 'daily limit', riskScore: 55 });
});

test('unreachable service or malformed verdict yields null (fall back locally)', async () => {
  const unreachable = createPolicyClient({
    policyConfig: enabledConfig,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    logger: silentLogger,
  });
  assert.equal(await unreachable.checkPolicy({ userId: 'u_1', amount: '1' }), null);

  const malformed = createPolicyClient({
    policyConfig: enabledConfig,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) }),
    logger: silentLogger,
  });
  assert.equal(await malformed.checkPolicy({ userId: 'u_1', amount: '1' }), null);
});
