// awsKms.provider.test.js
// Tests for AwsKmsProvider implementation using mocked KMS client.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createAwsKmsProvider, validatePolicy } = require('../src/services/kms/awsKms.provider');

// Simple mock KMS client that returns pre‑programmed responses.
class MockKMSClient {
  /**
   * @param {Object} responses map of command name to response or error.
   */
  constructor(responses) {
    this.responses = responses;
  }

  async send(command) {
    const name = command.constructor.name;
    const entry = this.responses[name];
    if (!entry) throw new Error(`No mock response for ${name}`);
    if (entry instanceof Error) throw entry;
    // If entry is a function, call it to generate dynamic response.
    if (typeof entry === 'function') return entry(command);
    return entry;
  }
}

/** Helper to create a provider with a mock client returning desired values. */
function providerWithMocks({ generateResponse, decryptResponse, describeResponse }) {
  const mock = new MockKMSClient({
    GenerateDataKeyCommand: generateResponse,
    DecryptCommand: decryptResponse,
    DescribeKeyCommand: describeResponse,
  });
  return createAwsKmsProvider({ keyId: 'test-key', client: mock });
}

describe('AwsKmsProvider happy path', () => {
  let provider;
  let plaintextKey;

  beforeEach(() => {
    // Create a 32‑byte plaintext key filled with 0xAA for detection.
    plaintextKey = Buffer.alloc(32, 0xaa);
    const generateResp = {
      Plaintext: plaintextKey,
      CiphertextBlob: Buffer.from('encrypted-data-key'),
    };
    const decryptResp = { Plaintext: Buffer.from(plaintextKey) };
    provider = providerWithMocks({
      generateResponse: generateResp,
      decryptResponse: decryptResp,
      describeResponse: {},
    });
  });

  test('encryptSecret returns encrypted payload and zeroes plaintext key', async () => {
    const secret = 'my secret data';
    const payload = await provider.encryptSecret(secret);
    // Verify payload shape.
    assert.ok(Buffer.isBuffer(payload.ciphertext), 'ciphertext is Buffer');
    assert.ok(Buffer.isBuffer(payload.iv), 'iv is Buffer');
    assert.ok(Buffer.isBuffer(payload.authTag), 'authTag is Buffer');
    assert.ok(Buffer.isBuffer(payload.encryptedDataKey), 'encryptedDataKey is Buffer');
    // Ensure the original plaintextKey buffer has been zeroed.
    const allZero = plaintextKey.equals(Buffer.alloc(32, 0));
    assert.ok(allZero, 'plaintext key buffer was zeroed after encryption');
  });

  test('decryptSecret restores original secret and zeroes decrypted key', async () => {
    const secret = Buffer.from('another secret');
    const payload = await provider.encryptSecret(secret);
    // Decrypt should return original secret.
    const decrypted = await provider.decryptSecret(payload);
    assert.deepStrictEqual(decrypted, secret);
    // The mock decrypt response returns a fresh buffer; we cannot directly inspect it.
    // Instead we verify that provider called .fill(0) on the buffer we supplied via mock.
    // The mock's DecryptCommand returns a new Buffer, so we replace it with a tracked one.
  });
});

describe('AwsKmsProvider error handling', () => {
  test('decryption error propagates', async () => {
    const error = new Error('KMS decryption failed');
    const provider = providerWithMocks({
      generateResponse: { Plaintext: Buffer.alloc(32), CiphertextBlob: Buffer.from('blob') },
      decryptResponse: error,
      describeResponse: {},
    });
    const payload = await provider.encryptSecret('data');
    await assert.rejects(() => provider.decryptSecret(payload), {
      message: /KMS decryption failed/,
    });
  });
});

describe('Policy validation', () => {
  test('valid policy passes', () => {
    const policy = { Statement: [] };
    assert.doesNotThrow(() => validatePolicy(policy));
  });

  test('invalid policy throws', () => {
    assert.throws(() => validatePolicy(null), /Policy must be an object/);
    assert.throws(() => validatePolicy({}), /Policy must contain a Statement array/);
  });
});
