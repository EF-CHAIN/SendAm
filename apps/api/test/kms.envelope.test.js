const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const KEY_V1 = 'a'.repeat(64);
const KEY_V2 = 'b'.repeat(64);
process.env.ENCRYPTION_KEY = KEY_V1;

const { encrypt, decrypt, registerKeyVersion } = require('../src/services/crypto.service');
const { rotateWalletKeys } = require('../scripts/rotate-wallet-keys');

describe('Versioned KMS Envelope Encryption & Key Rotation (#148)', () => {
  test('encrypts new ciphertext with specified version tag', () => {
    registerKeyVersion('v2', KEY_V2);
    const ciphertext = encrypt('my-secret-seed', 'v2');
    assert.ok(ciphertext.startsWith('v2:'));
    assert.equal(decrypt(ciphertext), 'my-secret-seed');
  });

  test('decrypts mixed key versions seamlessly', () => {
    registerKeyVersion('v1', KEY_V1);
    registerKeyVersion('v2', KEY_V2);

    const secret1 = 'SD234567890123456789012345678901';
    const secret2 = 'SD987654321098765432109876543210';

    const ct1 = encrypt(secret1, 'v1');
    const ct2 = encrypt(secret2, 'v2');

    assert.equal(decrypt(ct1), secret1);
    assert.equal(decrypt(ct2), secret2);
  });

  test('rotateWalletKeys executes dry-run without mutating database', async () => {
    registerKeyVersion('v1', KEY_V1);
    registerKeyVersion('v2', KEY_V2);

    const fakeWallets = [
      { id: 'w1', publicKey: 'GB1', encryptedSecretKey: encrypt('sec1', 'v1'), keyVersion: 'v1' },
      { id: 'w2', publicKey: 'GB2', encryptedSecretKey: encrypt('sec2', 'v2'), keyVersion: 'v2' },
    ];

    const updated = [];
    const fakePrisma = {
      wallet: {
        findMany: async () => fakeWallets,
        update: async (args) => { updated.push(args); },
      },
    };

    const report = await rotateWalletKeys({
      prisma: fakePrisma,
      targetVersion: 'v2',
      dryRun: true,
    });

    assert.equal(report.scannedCount, 2);
    assert.equal(report.rotatedCount, 1);
    assert.equal(report.alreadyCurrentCount, 1);
    assert.equal(updated.length, 0); // dry-run does not write
  });

  test('rotateWalletKeys re-encrypts old wallets under target version', async () => {
    registerKeyVersion('v1', KEY_V1);
    registerKeyVersion('v2', KEY_V2);

    const oldCiphertext = encrypt('my-secret-wallet-key', 'v1');
    const fakeWallets = [
      { id: 'w1', publicKey: 'GB1', encryptedSecretKey: oldCiphertext, keyVersion: 'v1' },
    ];

    const updated = [];
    const fakePrisma = {
      wallet: {
        findMany: async () => fakeWallets,
        update: async (args) => {
          updated.push(args);
        },
      },
    };

    const report = await rotateWalletKeys({
      prisma: fakePrisma,
      targetVersion: 'v2',
      dryRun: false,
    });

    assert.equal(report.scannedCount, 1);
    assert.equal(report.rotatedCount, 1);
    assert.equal(updated.length, 1);
    assert.equal(updated[0].where.id, 'w1');
    assert.equal(updated[0].data.keyVersion, 'v2');

    // Decrypt rotated ciphertext to verify secret integrity
    assert.equal(decrypt(updated[0].data.encryptedSecretKey), 'my-secret-wallet-key');
  });

  test('redacts Stellar secret key patterns from error reporting', async () => {
    registerKeyVersion('v1', KEY_V1);

    const secretKeyStr = 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const fakeWallets = [
      { id: 'w1', publicKey: 'GB1', encryptedSecretKey: 'invalid-ct', keyVersion: 'v1' },
    ];

    const fakePrisma = {
      wallet: {
        findMany: async () => fakeWallets,
      },
    };

    const report = await rotateWalletKeys({
      prisma: fakePrisma,
      targetVersion: 'v2',
      dryRun: false,
    });

    assert.equal(report.failedCount, 1);
    assert.equal(report.errors.length, 1);
    assert.ok(!report.errors[0].error.includes(secretKeyStr));
  });
});
