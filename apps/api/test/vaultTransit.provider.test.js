// Test for VaultTransitProvider using a local mock Vault server
const { createVaultTransitProvider } = require('../src/services/kms/vaultTransit.provider');
const http = require('http');
const assert = require('assert');

// Simple in‑memory mock data
let currentToken = 'initial-token';
let tokenRenewed = false;

function startMockVault(port) {
  const server = http.createServer((req, res) => {
    const { method, url, headers } = req;
    const token = headers['x-vault-token'];
    // Basic token verification
    if (token !== currentToken) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: ['invalid token'] }));
      return;
    }

    // Gather request body
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch (_) {/* ignore parse errors */}

      // Encryption endpoint
      if (url.startsWith('/v1/transit/encrypt/')) {
        const plaintext = Buffer.from(data.plaintext, 'base64').toString('utf8');
        const reversed = plaintext.split('').reverse().join('');
        const ciphertext = `vault:v1:${Buffer.from(reversed).toString('base64')}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { ciphertext } }));
        return;
      }

      // Decryption endpoint
      if (url.startsWith('/v1/transit/decrypt/')) {
        const ct = data.ciphertext;
        const b64 = ct.split(':').pop();
        const reversed = Buffer.from(b64, 'base64').toString('utf8');
        const plaintext = reversed.split('').reverse().join('');
        const out = Buffer.from(plaintext).toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { plaintext: out } }));
        return;
      }

      // Data‑key generation endpoint
      if (url.startsWith('/v1/transit/datakey/plaintext/')) {
        const bits = data.bits || 256;
        const keyBytes = bits / 8;
        const plaintextKey = Buffer.alloc(keyBytes, 0x42); // deterministic key
        const encryptedDataKey = `vault:v1:${plaintextKey.toString('base64')}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: {
              plaintext: plaintextKey.toString('base64'),
              ciphertext: encryptedDataKey,
            },
          })
        );
        return;
      }

      // Token renewal endpoint
      if (url === '/v1/auth/token/renew-self' && method === 'POST') {
        tokenRenewed = true;
        currentToken = 'renewed-token';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            auth: { client_token: currentToken, lease_duration: 3600 },
          })
        );
        return;
      }

      // Health‑check endpoint
      if (url === '/v1/sys/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sealed: false, initialized: true }));
        return;
      }

      // Fallback for unknown routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: ['not found'] }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

(async () => {
  const port = 18500 + Math.floor(Math.random() * 1000);
  const server = await startMockVault(port);
  const endpoint = `http://127.0.0.1:${port}`;

  const provider = createVaultTransitProvider({
    endpoint,
    token: currentToken,
    keyName: 'test-key',
    mountPath: 'transit',
  });

  // 1. Encrypt / Decrypt round‑trip
  const secret = 'hello world';
  const ciphertext = await provider.encrypt(secret);
  assert.ok(ciphertext.startsWith('vault:v1:'), 'ciphertext format');
  const decrypted = await provider.decrypt(ciphertext);
  assert.strictEqual(decrypted, secret, 'decrypt matches original');

  // 2. Context handling (mock ignores it, just ensure no error)
  const ctx = 'my‑context';
  const ct2 = await provider.encrypt(secret, { context: ctx });
  const dec2 = await provider.decrypt(ct2, { context: ctx });
  assert.strictEqual(dec2, secret, 'context round‑trip');

  // 3. Data‑key generation / decryption
  const { plaintextKey, encryptedDataKey } = await provider.generateDataKey({ bits: 256 });
  assert.strictEqual(plaintextKey.length, 32, 'plaintext key length 32 bytes');
  const decryptedKey = await provider.decryptDataKey(encryptedDataKey);
  assert.ok(decryptedKey.equals(plaintextKey), 'data‑key decryption matches');

  // 4. Token renewal & subsequent request using new token
  await provider.renewToken();
  assert.ok(tokenRenewed, 'token renewal called');
  const health = await provider.healthCheck();
  assert.strictEqual(health.sealed, false, 'health check works');

  // Cleanup
  server.close();
  console.log('All VaultTransitProvider tests passed');
})();
