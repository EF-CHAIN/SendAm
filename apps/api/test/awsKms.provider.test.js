'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-at-least-32-chars';

const {
  createAwsKmsProvider,
  AWS_KMS_ERROR_CODES,
} = require('../src/services/kms/awsKms.provider');
const {
  encryptEnvelope,
  decryptEnvelope,
  parseEnvelopeCiphertext,
  setKmsProvider,
  resetKmsProvider,
} = require('../src/services/crypto.service');

/**
 * Simulates an isolated AWS KMS service where CMKs live strictly inside the mock
 * and wrap/unwrap 256-bit DEKs bound to EncryptionContext and IAM policy.
 */
const createMockKmsClient = ({
  cmks = {
    'arn:aws:kms:us-east-1:123456789012:key/cmk-v1': crypto.randomBytes(32),
    'arn:aws:kms:us-east-1:123456789012:key/cmk-v2': crypto.randomBytes(32),
  },
  allowDecrypt = true,
  keyEnabled = true,
  forceResponseKeyId = null,
} = {}) => {
  const calls = [];

  const send = async (command) => {
    const name = command.constructor.name;
    const input = command.input;
    calls.push({ name, input });

    if (name === 'DescribeKeyCommand') {
      if (!cmks[input.KeyId]) {
        const err = new Error(`Key '${input.KeyId}' does not exist`);
        err.name = 'NotFoundException';
        throw err;
      }
      return {
        KeyMetadata: {
          KeyId: input.KeyId,
          Arn: input.KeyId,
          Enabled: keyEnabled,
          KeyState: keyEnabled ? 'Enabled' : 'Disabled',
        },
      };
    }

    if (name === 'GenerateDataKeyCommand') {
      const masterKey = cmks[input.KeyId];
      if (!masterKey) {
        const err = new Error(`Key '${input.KeyId}' does not exist`);
        err.name = 'NotFoundException';
        throw err;
      }
      const dek = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const aad = Buffer.from(JSON.stringify(input.EncryptionContext || {}), 'utf8');
      const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
      const tag = cipher.getAuthTag();
      const blob = Buffer.from(JSON.stringify({
        keyId: input.KeyId,
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        data: encrypted.toString('hex'),
      }), 'utf8');

      return {
        KeyId: input.KeyId,
        Plaintext: new Uint8Array(dek),
        CiphertextBlob: new Uint8Array(blob),
      };
    }

    if (name === 'DecryptCommand') {
      if (!allowDecrypt) {
        const err = new Error('User is not authorized to perform: kms:Decrypt on resource');
        err.name = 'AccessDeniedException';
        throw err;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.from(input.CiphertextBlob).toString('utf8'));
      } catch (_err) {
        const err = new Error('Invalid ciphertext');
        err.name = 'InvalidCiphertextException';
        throw err;
      }

      const masterKey = cmks[parsed.keyId];
      if (!masterKey) {
        const err = new Error('Unknown key');
        err.name = 'NotFoundException';
        throw err;
      }

      try {
        const aad = Buffer.from(JSON.stringify(input.EncryptionContext || {}), 'utf8');
        const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(parsed.iv, 'hex'));
        decipher.setAAD(aad);
        decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(parsed.data, 'hex')),
          decipher.final(),
        ]);
        return {
          KeyId: forceResponseKeyId || parsed.keyId,
          Plaintext: new Uint8Array(plaintext),
        };
      } catch (_err) {
        const err = new Error('Encryption context mismatch or corrupted ciphertext');
        err.name = 'InvalidCiphertextException';
        throw err;
      }
    }

    throw new Error(`Unexpected command: ${name}`);
  };

  return { send, calls };
};

describe('AWS KMS Provider (#954)', () => {
  afterEach(() => {
    resetKmsProvider();
  });

  test('generateDataKey and decryptDataKey round-trip a 32-byte DEK using remote CMK', async () => {
    const cmkArn = 'arn:aws:kms:us-east-1:123456789012:key/cmk-v1';
    const kmsClient = createMockKmsClient();
    const provider = createAwsKmsProvider({
      keyId: cmkArn,
      kmsClient,
      encryptionContext: { service: 'sendam-api', env: 'test' },
    });

    const generated = await provider.generateDataKey({ keyVersion: 'v1' });
    assert.equal(generated.keyId, cmkArn);
    assert.equal(generated.keyVersion, 'v1');
    assert.ok(Buffer.isBuffer(generated.plaintextKey));
    assert.equal(generated.plaintextKey.length, 32);
    assert.equal(typeof generated.encryptedDataKey, 'string');

    const decrypted = await provider.decryptDataKey({
      encryptedDataKey: generated.encryptedDataKey,
      keyVersion: 'v1',
      keyId: generated.keyId,
    });

    assert.deepEqual(decrypted, generated.plaintextKey);
    assert.equal(kmsClient.calls[0].name, 'GenerateDataKeyCommand');
    assert.equal(kmsClient.calls[1].name, 'DecryptCommand');
    assert.equal(kmsClient.calls[1].input.EncryptionContext.service, 'sendam-api');
    assert.equal(kmsClient.calls[1].input.EncryptionContext.keyVersion, 'v1');
  });

  test('integrates with crypto.service encryptEnvelope / decryptEnvelope and stores keyId + encrypted DEK', async () => {
    const cmkV1 = 'arn:aws:kms:us-east-1:123456789012:key/cmk-v1';
    const cmkV2 = 'arn:aws:kms:us-east-1:123456789012:key/cmk-v2';
    const kmsClient = createMockKmsClient();
    const provider = createAwsKmsProvider({
      keyId: cmkV1,
      keyVersionMap: { v1: cmkV1, v2: cmkV2 },
      kmsClient,
    });

    setKmsProvider(provider);

    const secret = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4';
    const envelope = await encryptEnvelope(secret, {
      keyVersion: 'v2',
      encryptionContext: { walletId: 'wallet_123' },
    });

    assert.equal(envelope.provider, 'aws-kms');
    assert.equal(envelope.keyVersion, 'v2');
    assert.equal(envelope.keyId, cmkV2);
    assert.ok(envelope.serialized.startsWith('env:v1:aws-kms:v2:'));

    const parsed = parseEnvelopeCiphertext(envelope.serialized);
    assert.equal(parsed.keyId, cmkV2);
    assert.equal(parsed.encryptedDataKey, envelope.encryptedDataKey);

    const recovered = await decryptEnvelope(envelope.serialized, {
      encryptionContext: { walletId: 'wallet_123' },
    });
    assert.equal(recovered, secret);
  });

  test('enforces IAM policy denial with KMS_ACCESS_DENIED', async () => {
    const cmkArn = 'arn:aws:kms:us-east-1:123456789012:key/cmk-v1';
    const kmsClient = createMockKmsClient({ allowDecrypt: false });
    const provider = createAwsKmsProvider({ keyId: cmkArn, kmsClient });

    const generated = await provider.generateDataKey({ keyVersion: 'v1' });
    await assert.rejects(
      () => provider.decryptDataKey({
        encryptedDataKey: generated.encryptedDataKey,
        keyVersion: 'v1',
      }),
      (err) => err.code === AWS_KMS_ERROR_CODES.ACCESS_DENIED && err.statusCode === 403 && err.retryable === false,
    );
  });

  test('rejects decryption when EncryptionContext does not match', async () => {
    const cmkArn = 'arn:aws:kms:us-east-1:123456789012:key/cmk-v1';
    const kmsClient = createMockKmsClient();
    const provider = createAwsKmsProvider({ keyId: cmkArn, kmsClient });

    const generated = await provider.generateDataKey({
      keyVersion: 'v1',
      encryptionContext: { tenant: 'alpha' },
    });

    await assert.rejects(
      () => provider.decryptDataKey({
        encryptedDataKey: generated.encryptedDataKey,
        keyVersion: 'v1',
        encryptionContext: { tenant: 'beta' },
      }),
      (err) => err.code === AWS_KMS_ERROR_CODES.INVALID_CIPHERTEXT,
    );
  });

  test('rejects decryption if KMS returns an unexpected CMK KeyId', async () => {
    const cmkArn = 'arn:aws:kms:us-east-1:123456789012:key/cmk-v1';
    const kmsClient = createMockKmsClient({
      forceResponseKeyId: 'arn:aws:kms:us-east-1:999999999999:key/rogue-key',
    });
    const provider = createAwsKmsProvider({ keyId: cmkArn, kmsClient });

    const generated = await provider.generateDataKey({ keyVersion: 'v1' });
    await assert.rejects(
      () => provider.decryptDataKey({
        encryptedDataKey: generated.encryptedDataKey,
        keyVersion: 'v1',
        keyId: cmkArn,
      }),
      (err) => err.code === AWS_KMS_ERROR_CODES.KEY_MISMATCH,
    );
  });

  test('validateKeyAccess verifies enabled CMKs and rejects disabled ones', async () => {
    const cmkArn = 'arn:aws:kms:us-east-1:123456789012:key/cmk-v1';
    const enabledProvider = createAwsKmsProvider({
      keyId: cmkArn,
      kmsClient: createMockKmsClient({ keyEnabled: true }),
    });
    const info = await enabledProvider.validateKeyAccess();
    assert.equal(info.enabled, true);
    assert.equal(info.keyState, 'Enabled');

    const disabledProvider = createAwsKmsProvider({
      keyId: cmkArn,
      kmsClient: createMockKmsClient({ keyEnabled: false }),
    });
    await assert.rejects(
      () => disabledProvider.validateKeyAccess(),
      (err) => err.code === AWS_KMS_ERROR_CODES.DISABLED,
    );
  });

  test('fails with KMS_MISCONFIGURED when no keyId is configured', async () => {
    const provider = createAwsKmsProvider({
      keyId: '',
      kmsClient: createMockKmsClient(),
    });

    await assert.rejects(
      () => provider.generateDataKey({ keyVersion: 'v1' }),
      (err) => err.code === AWS_KMS_ERROR_CODES.MISCONFIGURED,
    );
  });
});
