'use strict';

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { Keypair } = require('@stellar/stellar-sdk');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-at-least-32-chars';

const {
  createVaultTransitProvider,
  VAULT_ERROR_CODES,
} = require('../src/services/kms/vaultTransit.provider');
const {
  encryptEnvelope,
  decryptEnvelope,
  setKmsProvider,
  resetKmsProvider,
} = require('../src/services/crypto.service');

/**
 * Local in-process HashiCorp Vault Transit HTTP mock server.
 * Implements real AES-256-GCM Transit encrypt/decrypt/rewrap/datakey,
 * token lookup/renewal, and sealed/auth error simulation over HTTP.
 */
const startMockVaultServer = async () => {
  const keys = {
    'sendam-wallet-key': {
      latestVersion: 1,
      versions: {
        1: crypto.randomBytes(32),
      },
    },
  };

  let activeToken = 'hvs.initial-test-token';
  let renewCount = 0;
  let tokenTtl = 120;
  let sealed = false;
  let requireRenewOnce = false;

  const encryptWithVaultKey = (keyName, plaintextBuf, contextB64 = '') => {
    const entry = keys[keyName];
    if (!entry) return null;
    const ver = entry.latestVersion;
    const keyBuf = entry.versions[ver];
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
    if (contextB64) cipher.setAAD(Buffer.from(contextB64, 'base64'));
    const encrypted = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, encrypted]).toString('base64');
    return { ciphertext: `vault:v${ver}:${packed}`, keyVersion: ver };
  };

  const decryptWithVaultKey = (keyName, ciphertext, contextB64 = '') => {
    const entry = keys[keyName];
    if (!entry) return null;
    const match = /^vault:v(\d+):(.+)$/.exec(ciphertext);
    if (!match) throw new Error('invalid ciphertext');
    const ver = Number(match[1]);
    const keyBuf = entry.versions[ver];
    if (!keyBuf) throw new Error('unknown key version');
    const packed = Buffer.from(match[2], 'base64');
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const data = packed.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    if (contextB64) decipher.setAAD(Buffer.from(contextB64, 'base64'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.url === '/v1/sys/health') {
      return sendJson(sealed ? 503 : 200, { initialized: true, sealed });
    }

    const token = req.headers['x-vault-token'];
    if (!token || token !== activeToken) {
      return sendJson(403, { errors: ['permission denied'] });
    }

    if (req.url === '/v1/auth/token/lookup-self' && req.method === 'GET') {
      return sendJson(200, {
        data: {
          renewable: true,
          ttl: tokenTtl,
          policies: ['default', 'sendam-transit'],
          accessor: 'acc_test_123',
        },
      });
    }

    if (req.url === '/v1/auth/token/renew-self' && req.method === 'POST') {
      await readJson(req);
      renewCount += 1;
      tokenTtl = 3600;
      requireRenewOnce = false;
      return sendJson(200, {
        auth: {
          client_token: activeToken,
          lease_duration: 3600,
          renewable: true,
          policies: ['default', 'sendam-transit'],
        },
      });
    }

    if (sealed) {
      return sendJson(503, { errors: ['Vault is sealed'] });
    }

    if (requireRenewOnce) {
      return sendJson(403, { errors: ['token expired, renewal required'] });
    }

    const body = await readJson(req);

    const encMatch = /^\/v1\/transit\/encrypt\/([^/]+)$/.exec(req.url);
    if (encMatch && req.method === 'POST') {
      const keyName = decodeURIComponent(encMatch[1]);
      const result = encryptWithVaultKey(keyName, Buffer.from(body.plaintext, 'base64'), body.context || '');
      if (!result) return sendJson(404, { errors: ['encryption key not found'] });
      return sendJson(200, { data: { ciphertext: result.ciphertext, key_version: result.keyVersion } });
    }

    const decMatch = /^\/v1\/transit\/decrypt\/([^/]+)$/.exec(req.url);
    if (decMatch && req.method === 'POST') {
      const keyName = decodeURIComponent(decMatch[1]);
      if (!keys[keyName]) return sendJson(404, { errors: ['encryption key not found'] });
      try {
        const plain = decryptWithVaultKey(keyName, body.ciphertext, body.context || '');
        return sendJson(200, { data: { plaintext: plain.toString('base64') } });
      } catch (err) {
        return sendJson(400, { errors: [err.message] });
      }
    }

    const rewrapMatch = /^\/v1\/transit\/rewrap\/([^/]+)$/.exec(req.url);
    if (rewrapMatch && req.method === 'POST') {
      const keyName = decodeURIComponent(rewrapMatch[1]);
      if (!keys[keyName]) return sendJson(404, { errors: ['encryption key not found'] });
      try {
        const plain = decryptWithVaultKey(keyName, body.ciphertext, body.context || '');
        const result = encryptWithVaultKey(keyName, plain, body.context || '');
        return sendJson(200, { data: { ciphertext: result.ciphertext, key_version: result.keyVersion } });
      } catch (err) {
        return sendJson(400, { errors: [err.message] });
      }
    }

    const datakeyMatch = /^\/v1\/transit\/datakey\/plaintext\/([^/]+)$/.exec(req.url);
    if (datakeyMatch && req.method === 'POST') {
      const keyName = decodeURIComponent(datakeyMatch[1]);
      if (!keys[keyName]) return sendJson(404, { errors: ['encryption key not found'] });
      const dek = crypto.randomBytes(32);
      const result = encryptWithVaultKey(keyName, dek, body.context || '');
      return sendJson(200, {
        data: {
          plaintext: dek.toString('base64'),
          ciphertext: result.ciphertext,
          key_version: result.keyVersion,
        },
      });
    }

    return sendJson(404, { errors: ['unsupported path'] });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    address: `http://127.0.0.1:${port}`,
    token: activeToken,
    getRenewCount: () => renewCount,
    resetState: () => {
      renewCount = 0;
      tokenTtl = 120;
      sealed = false;
      requireRenewOnce = false;
    },
    setSealed: (val) => { sealed = val; },
    setRequireRenewOnce: (val) => { requireRenewOnce = val; },
    rotateKey: (keyName = 'sendam-wallet-key') => {
      const entry = keys[keyName];
      entry.latestVersion += 1;
      entry.versions[entry.latestVersion] = crypto.randomBytes(32);
      return entry.latestVersion;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

describe('HashiCorp Vault Transit Engine Provider (#955)', () => {
  let vault;

  before(async () => {
    vault = await startMockVaultServer();
  });

  after(async () => {
    await vault.close();
  });

  afterEach(() => {
    resetKmsProvider();
    vault.resetState();
  });

  test('round-trips direct zero-exposure encryption, decryption, and key rewrap against Vault HTTP API', async () => {
    const provider = createVaultTransitProvider({
      address: vault.address,
      token: vault.token,
      keyName: 'sendam-wallet-key',
    });

    const secret = Keypair.random().secret();
    const enc = await provider.encrypt({
      plaintext: secret,
      context: { walletId: 'w_vault_1' },
    });

    assert.ok(enc.ciphertext.startsWith('vault:v'));
    const dec = await provider.decrypt({
      ciphertext: enc.ciphertext,
      context: { walletId: 'w_vault_1' },
    });
    assert.equal(dec, secret);

    // Rotate key in Vault and rewrap ciphertext without exposing plaintext
    const newVer = vault.rotateKey('sendam-wallet-key');
    const rewrapped = await provider.rewrap({
      ciphertext: enc.ciphertext,
      context: { walletId: 'w_vault_1' },
    });
    assert.ok(rewrapped.ciphertext.startsWith(`vault:v${newVer}:`));
    assert.equal(
      await provider.decrypt({ ciphertext: rewrapped.ciphertext, context: { walletId: 'w_vault_1' } }),
      secret,
    );
  });

  test('supports proactive and reactive token renewal with lease tracking', async () => {
    const provider = createVaultTransitProvider({
      address: vault.address,
      token: vault.token,
      tokenRenewThresholdSec: 300,
    });

    // Lookup reports TTL=120s (< 300s threshold), so next encrypt proactively renews token
    const lookup = await provider.lookupToken();
    assert.equal(lookup.renewable, true);
    assert.equal(lookup.ttl, 120);

    const enc = await provider.encrypt({ plaintext: 'renew-test-secret' });
    assert.equal(vault.getRenewCount(), 1);
    assert.equal(await provider.decrypt({ ciphertext: enc.ciphertext }), 'renew-test-secret');

    // Simulate 403 requiring token renewal on next call
    vault.setRequireRenewOnce(true);
    const enc2 = await provider.encrypt({ plaintext: 'reactive-renew-secret' });
    assert.equal(vault.getRenewCount(), 2);
    assert.equal(await provider.decrypt({ ciphertext: enc2.ciphertext }), 'reactive-renew-secret');
  });

  test('integrates with crypto.service encryptEnvelope / decryptEnvelope in both DEK and directTransit modes', async () => {
    const provider = createVaultTransitProvider({
      address: vault.address,
      token: vault.token,
    });
    setKmsProvider(provider);

    const secret = 'SD3LXDKBOWNCBPKSRHA752M3S4P5S3D2A5M3C7F3W7T5E4S3T2S1E0C9';

    // Mode 1: Envelope DEK via Vault datakey/plaintext
    const dekEnv = await encryptEnvelope(secret, { keyVersion: 'v1' });
    assert.equal(dekEnv.mode, 'envelope');
    assert.equal(dekEnv.provider, 'vault-transit');
    assert.equal(await decryptEnvelope(dekEnv.serialized), secret);

    // Mode 2: Direct Transit (zero-exposure)
    const directEnv = await encryptEnvelope(secret, { directTransit: true });
    assert.equal(directEnv.mode, 'direct');
    assert.ok(directEnv.serialized.startsWith('kms:v1:vault-transit:'));
    assert.equal(await decryptEnvelope(directEnv.serialized), secret);
  });

  test('handles health check, sealed Vault (503), auth denial (403), and missing key (404)', async () => {
    const provider = createVaultTransitProvider({
      address: vault.address,
      token: vault.token,
      autoRenewToken: false,
    });

    const health = await provider.healthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.sealed, false);

    vault.setSealed(true);
    await assert.rejects(
      () => provider.encrypt({ plaintext: 'sealed-test' }),
      (err) => err.code === VAULT_ERROR_CODES.UNAVAILABLE && err.retryable === true,
    );
    vault.setSealed(false);

    await assert.rejects(
      () => provider.encrypt({ plaintext: 'missing-key', keyName: 'nonexistent-key' }),
      (err) => err.code === VAULT_ERROR_CODES.KEY_NOT_FOUND,
    );

    const badAuthProvider = createVaultTransitProvider({
      address: vault.address,
      token: 'hvs.invalid-token',
      autoRenewToken: false,
    });
    await assert.rejects(
      () => badAuthProvider.encrypt({ plaintext: 'bad-token' }),
      (err) => err.code === VAULT_ERROR_CODES.AUTH_FAILED && !err.message.includes('hvs.invalid-token'),
    );
  });
});
