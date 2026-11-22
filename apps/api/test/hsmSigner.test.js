'use strict';

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-at-least-32-chars';

const { StellarSdk } = require('../src/config/stellar');
const { createHsmSigner, HSM_ERROR_CODES } = require('../src/wallet/hsmSigner');
const walletService = require('../src/wallet/wallet.service');
const stellarAdapter = require('../src/wallet/stellar.adapter');

/**
 * Isolated in-process HSM HTTP server.
 * Private keys exist ONLY inside this server closure and are never returned to clients.
 */
const startMockHsmServer = async () => {
  const keysById = new Map();
  const apiKey = crypto.randomBytes(16).toString('hex');
  let transientFailuresRemaining = 0;
  let forceBadSignature = false;
  let denyPolicy = false;
  let signCalls = 0;

  // Pre-register a keypair inside the HSM
  const defaultKeypair = StellarSdk.Keypair.random();
  keysById.set('wallet-key-1', defaultKeypair);

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

    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      return sendJson(401, { error: 'Unauthorized' });
    }

    if (req.url === '/v1/health' && req.method === 'GET') {
      return sendJson(200, { status: 'ok', module: 'soft-hsm' });
    }

    if (req.url === '/v1/keys' && req.method === 'POST') {
      const body = await readJson(req);
      const kp = StellarSdk.Keypair.random();
      const keyId = body.keyId || `hsm_${Date.now()}`;
      keysById.set(keyId, kp);
      // Never return secret key
      return sendJson(201, { keyId, publicKey: kp.publicKey() });
    }

    const pubMatch = /^\/v1\/keys\/([^/]+)\/public-key$/.exec(req.url);
    if (pubMatch && req.method === 'GET') {
      const keyId = decodeURIComponent(pubMatch[1]);
      const kp = keysById.get(keyId);
      if (!kp) return sendJson(404, { error: 'Key not found' });
      return sendJson(200, { keyId, publicKey: kp.publicKey() });
    }

    if (req.url === '/v1/sign' && req.method === 'POST') {
      signCalls += 1;
      if (transientFailuresRemaining > 0) {
        transientFailuresRemaining -= 1;
        return sendJson(503, { error: 'HSM temporarily busy' });
      }
      if (denyPolicy) {
        return sendJson(403, { error: 'Signing policy denied transaction' });
      }

      const body = await readJson(req);
      const kp = keysById.get(body.keyId);
      if (!kp) return sendJson(404, { error: 'Key not found' });

      const hashBuf = Buffer.from(body.hash, 'base64');
      const sig = forceBadSignature
        ? Buffer.alloc(64, 0xab)
        : kp.sign(hashBuf);

      return sendJson(200, {
        keyId: body.keyId,
        publicKey: kp.publicKey(),
        signature: sig.toString('base64'),
      });
    }

    return sendJson(404, { error: 'Not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    endpoint: `http://127.0.0.1:${port}`,
    apiKey,
    defaultKeyId: 'wallet-key-1',
    defaultPublicKey: defaultKeypair.publicKey(),
    getSignCalls: () => signCalls,
    resetState: () => {
      transientFailuresRemaining = 0;
      forceBadSignature = false;
      denyPolicy = false;
      signCalls = 0;
    },
    setTransientFailures: (n) => { transientFailuresRemaining = n; },
    setForceBadSignature: (v) => { forceBadSignature = v; },
    setDenyPolicy: (v) => { denyPolicy = v; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

describe('Hardware Security Module (HSM) Signing Service (#957)', () => {
  let hsmServer;

  before(async () => {
    hsmServer = await startMockHsmServer();
  });

  after(async () => {
    await hsmServer.close();
  });

  afterEach(() => {
    hsmServer.resetState();
    walletService.setHsmSigner(null);
  });

  test('signs a Stellar transaction via remote HSM without private keys in API memory', async () => {
    const hsm = createHsmSigner({
      endpoint: hsmServer.endpoint,
      apiKey: hsmServer.apiKey,
    });

    const destination = StellarSdk.Keypair.random().publicKey();
    const account = new StellarSdk.Account(hsmServer.defaultPublicKey, '100');
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination,
          asset: StellarSdk.Asset.native(),
          amount: '10.0000000',
        }),
      )
      .setTimeout(30)
      .build();

    assert.equal(tx.signatures.length, 0);

    await hsm.signTransaction({
      transaction: tx,
      keyId: hsmServer.defaultKeyId,
      publicKey: hsmServer.defaultPublicKey,
    });

    assert.equal(tx.signatures.length, 1);
    const sigBuf = tx.signatures[0].signature();
    const verifier = StellarSdk.Keypair.fromPublicKey(hsmServer.defaultPublicKey);
    assert.equal(verifier.verify(tx.hash(), sigBuf), true);
  });

  test('provisions non-exportable keys and retrieves public keys from HSM', async () => {
    const hsm = createHsmSigner({
      endpoint: hsmServer.endpoint,
      apiKey: hsmServer.apiKey,
    });

    const created = await hsm.createKey({ keyId: 'customer-wallet-99', metadata: { env: 'test' } });
    assert.equal(created.keyId, 'customer-wallet-99');
    assert.ok(StellarSdk.StrKey.isValidEd25519PublicKey(created.publicKey));
    assert.equal('secretKey' in created, false);

    const fetched = await hsm.getPublicKey({ keyId: 'customer-wallet-99' });
    assert.equal(fetched.publicKey, created.publicKey);

    const health = await hsm.healthCheck();
    assert.equal(health.ok, true);
  });

  test('rejects spoofed/invalid Ed25519 signatures returned by HSM', async () => {
    hsmServer.setForceBadSignature(true);
    const hsm = createHsmSigner({
      endpoint: hsmServer.endpoint,
      apiKey: hsmServer.apiKey,
    });

    const hash = Buffer.alloc(32, 7);
    await assert.rejects(
      () => hsm.signHash({
        keyId: hsmServer.defaultKeyId,
        publicKey: hsmServer.defaultPublicKey,
        hash,
      }),
      (err) => err.code === HSM_ERROR_CODES.INVALID_SIGNATURE,
    );
  });

  test('retries transient 503 HSM errors and fails fast on 403 policy denials', async () => {
    const hsm = createHsmSigner({
      endpoint: hsmServer.endpoint,
      apiKey: hsmServer.apiKey,
      maxRetries: 2,
      retryBaseDelayMs: 10,
    });

    hsmServer.setTransientFailures(2);
    const result = await hsm.signHash({
      keyId: hsmServer.defaultKeyId,
      publicKey: hsmServer.defaultPublicKey,
      hash: Buffer.alloc(32, 1),
    });
    assert.equal(result.signature.length, 64);
    assert.equal(hsmServer.getSignCalls(), 3);

    hsmServer.resetState();
    hsmServer.setDenyPolicy(true);
    await assert.rejects(
      () => hsm.signHash({
        keyId: hsmServer.defaultKeyId,
        publicKey: hsmServer.defaultPublicKey,
        hash: Buffer.alloc(32, 2),
      }),
      (err) => err.code === HSM_ERROR_CODES.POLICY_DENIED && err.retryable === false,
    );
    assert.equal(hsmServer.getSignCalls(), 1);
  });

  test('wallet.service.submitPayment delegates to HSM signer without encryptedSecretKey in memory', async () => {
    const hsm = createHsmSigner({
      endpoint: hsmServer.endpoint,
      apiKey: hsmServer.apiKey,
    });
    walletService.setHsmSigner(hsm);

    let capturedParams = null;
    const origSubmit = stellarAdapter.submitPayment;
    stellarAdapter.submitPayment = async (params) => {
      capturedParams = params;
      return { txHash: 'mock_tx_hash', explorerUrl: 'https://stellar.expert/explorer/testnet/tx/mock_tx_hash' };
    };

    try {
      const destination = StellarSdk.Keypair.random().publicKey();
      const res = await walletService.submitPayment({
        wallet: {
          id: 'w_hsm_1',
          publicKey: hsmServer.defaultPublicKey,
          encryptedSecretKey: null, // No private key stored or decrypted!
          keyVersion: `hsm:${hsmServer.defaultKeyId}`,
          network: 'testnet',
          networkProvenance: 'verified',
        },
        destination,
        amount: '5',
        asset: 'XLM',
      });

      assert.equal(res.txHash, 'mock_tx_hash');
      assert.equal(capturedParams.secretKey, undefined);
      assert.equal(capturedParams.signer.mode, 'hsm');
      assert.equal(capturedParams.signer.publicKey, hsmServer.defaultPublicKey);
    } finally {
      stellarAdapter.submitPayment = origSubmit;
    }
  });
});
