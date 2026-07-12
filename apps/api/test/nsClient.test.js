const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const { createNsClient, nsClient } = require('../src/services/nsClient');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const enabledConfig = { enabled: true, serviceUrl: 'http://ns.internal', secret: 's', domain: 'sendam.app' };
const STELLAR_ACCOUNT = `G${'A'.repeat(55)}`;

test('default client is disabled when env is unset', async () => {
  assert.equal(nsClient.enabled, false);
  assert.equal(await nsClient.resolveName('@ada'), null);
});

test('maps sigil forms to federation queries; bare names are refused', () => {
  const client = createNsClient({ nsConfig: enabledConfig, logger: silentLogger });
  assert.equal(client.toFederationQuery('@ada'), 'ada*sendam.app');
  assert.equal(client.toFederationQuery('@Ada '), 'ada*sendam.app');
  assert.equal(client.toFederationQuery('bola*other.app'), 'bola*other.app');
  assert.equal(client.toFederationQuery('mama'), null); // bare name: contacts only
  assert.equal(client.toFederationQuery('@'), null);
  assert.equal(client.toFederationQuery(''), null);
});

test('resolves a known global name through the federation endpoint', async () => {
  const client = createNsClient({
    nsConfig: enabledConfig,
    fetchImpl: async (url) => {
      assert.match(url, /\/federation\?q=ada\*sendam\.app&type=name$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ stellar_address: 'ada*sendam.app', account_id: STELLAR_ACCOUNT }),
      };
    },
    logger: silentLogger,
  });

  const resolved = await client.resolveName('@ada');
  assert.deepEqual(resolved, { accountId: STELLAR_ACCOUNT, stellarAddress: 'ada*sendam.app' });
});

test('unknown names (SEP-0002 404) and unreachable service resolve to null', async () => {
  const notFound = createNsClient({
    nsConfig: enabledConfig,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ code: 'not_found', detail: 'x' }) }),
    logger: silentLogger,
  });
  assert.equal(await notFound.resolveName('@ghost'), null);

  const unreachable = createNsClient({
    nsConfig: enabledConfig,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    logger: silentLogger,
  });
  assert.equal(await unreachable.resolveName('@ada'), null);
});

test('bare names never trigger a network call even when enabled', async () => {
  let called = false;
  const client = createNsClient({
    nsConfig: enabledConfig,
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
    logger: silentLogger,
  });
  assert.equal(await client.resolveName('mama'), null);
  assert.equal(called, false);
});
