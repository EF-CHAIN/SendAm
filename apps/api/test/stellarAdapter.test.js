const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const stellarAdapter = require('../src/wallet/stellar.adapter');

test('createWallet returns a valid Stellar keypair', () => {
  const { publicKey, secretKey } = stellarAdapter.createWallet();
  assert.equal(typeof publicKey, 'string');
  assert.equal(publicKey[0], 'G');
  assert.equal(publicKey.length, 56);
  assert.equal(secretKey[0], 'S');
  assert.equal(stellarAdapter.validateAddress(publicKey), true);
});

test('validateAddress rejects non-Stellar input', () => {
  assert.equal(stellarAdapter.validateAddress('0xab12ab12ab12ab12ab12ab12ab12ab12ab12ab12'), false);
  assert.equal(stellarAdapter.validateAddress('not-an-address'), false);
  assert.equal(stellarAdapter.validateAddress(''), false);
  assert.equal(stellarAdapter.validateAddress(null), false);
  // Right shape, wrong checksum.
  assert.equal(stellarAdapter.validateAddress(`G${'A'.repeat(55)}`), false);
});

test('resolveAsset maps XLM/native and rejects unknown assets', () => {
  assert.equal(stellarAdapter.resolveAsset('XLM').isNative(), true);
  assert.equal(stellarAdapter.resolveAsset('native').isNative(), true);
  assert.equal(stellarAdapter.resolveAsset(undefined).isNative(), true);
  assert.throws(() => stellarAdapter.resolveAsset('DOGE'), /Unsupported asset/);
});

test('adapter identifies as the stellar chain', () => {
  assert.equal(stellarAdapter.chain, 'stellar');
});
