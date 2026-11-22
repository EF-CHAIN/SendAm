'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { StellarSdk } = require('../src/config/stellar');
const { createHsmSigner } = require('../src/wallet/hsmSigner');

describe('HSM Remote Signing Service (#957)', () => {
  let server;
  let serverUrl;
  let hsmKeypair;
  let signer;

  before(async () => {
    // Generate an isolated keypair known only to the mock HSM service
    hsmKeypair = StellarSdk.Keypair.random();

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', hsmStatus: 'online' }));
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/keys/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          keyId: 'key-1',
          publicKey: hsmKeypair.publicKey(),
          algorithm: 'ed25519',
        }));
      }

      if (req.method === 'POST' && url.pathname === '/v1/sign') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const hashBuf = Buffer.from(parsed.hash, 'hex');

          // Isolated HSM signs hash with Ed25519
          const signature = hsmKeypair.sign(hashBuf);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            signature: signature.toString('hex'),
            signatureFormat: 'hex',
            publicKey: hsmKeypair.publicKey(),
          }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        serverUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    signer = createHsmSigner({
      endpoint: serverUrl,
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('healthCheck returns HSM status', async () => {
    const health = await signer.healthCheck();
    assert.equal(health.status, 'ok');
  });

  test('getPublicKey returns public key from HSM', async () => {
    const pubKey = await signer.getPublicKey('key-1');
    assert.equal(pubKey, hsmKeypair.publicKey());
  });

  test('signHash returns valid Ed25519 signature without exposing private key', async () => {
    const sampleData = Buffer.alloc(32, 0x42);
    const result = await signer.signHash({
      keyId: 'key-1',
      hash: sampleData,
    });

    assert.ok(result.signature);
    assert.equal(result.publicKey, hsmKeypair.publicKey());

    // Verify signature against public key
    const verifier = StellarSdk.Keypair.fromPublicKey(result.publicKey);
    assert.ok(verifier.verify(sampleData, result.signature));
  });

  test('signTransaction attaches valid signature to Stellar transaction', async () => {
    const sourceAccount = new StellarSdk.Account(hsmKeypair.publicKey(), '100');
    const destination = StellarSdk.Keypair.random().publicKey();

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(StellarSdk.Operation.payment({
        destination,
        asset: StellarSdk.Asset.native(),
        amount: '10',
      }))
      .setTimeout(30)
      .build();

    assert.equal(tx.signatures.length, 0);

    const signedTx = await signer.signTransaction(tx, {
      keyId: 'key-1',
      networkPassphrase: StellarSdk.Networks.TESTNET,
    });

    assert.equal(signedTx.signatures.length, 1);

    // Cryptographic validation of transaction envelope signature
    const txHash = signedTx.hash(StellarSdk.Networks.TESTNET);
    const verifier = StellarSdk.Keypair.fromPublicKey(hsmKeypair.publicKey());
    const signatureBuffer = signedTx.signatures[0].signature();
    assert.ok(verifier.verify(txHash, signatureBuffer));
  });
});
