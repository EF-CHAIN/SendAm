'use strict';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { rotateWalletKeysBatch, createCheckpointStore } = require('../src/services/secret-rotation.service');
const { runKeyRotationJob } = require('../src/jobs/keyRotation.job');
const cryptoService = require('../src/services/crypto.service');

function generateWallets(count, startId = 1, version = 'v1') {
  const wallets = [];
  for (let i = 0; i < count; i++) {
    const id = `wallet-${startId + i}`;
    wallets.push({
      id,
      publicKey: `G${String(startId + i).padStart(55, 'A')}`,
      encryptedSecretKey: cryptoService.encrypt(`secret-key-${id}`, version),
      keyVersion: version,
    });
  }
  return wallets;
}

function createMockPrisma(wallets) {
  return {
    wallet: {
      async findMany({ where, orderBy: _orderBy, take }) {
        let result = wallets.slice();
        if (where?.keyVersion?.not !== undefined) {
          result = result.filter((w) => w.keyVersion !== where.keyVersion.not);
        }
        if (where?.encryptedSecretKey?.not !== undefined) {
          result = result.filter((w) => w.encryptedSecretKey !== null);
        }
        if (where?.id?.gt !== undefined) {
          result = result.filter((w) => w.id > where.id.gt);
        }
        result.sort((a, b) => a.id.localeCompare(b.id));
        if (take) {
          result = result.slice(0, take);
        }
        return result;
      },
      async update({ where, data }) {
        const wallet = wallets.find((w) => w.id === where.id);
        if (!wallet) throw new Error('Wallet not found');
        Object.assign(wallet, data);
        return wallet;
      },
    },
  };
}

describe('Resumable Key Rotation Worker (#956)', () => {
  test('re-encrypts 10,000 wallets in batches of 100', async () => {
    const wallets = generateWallets(10000, 1, 'v1');
    const prisma = createMockPrisma(wallets);
    const store = createCheckpointStore('memory');

    const result = await rotateWalletKeysBatch({
      prisma,
      targetVersion: 'v2',
      batchSize: 100,
      checkpointStore: store,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.scannedCount, 10000);
    assert.equal(result.rotatedCount, 10000);
    assert.equal(result.failedCount, 0);

    const check = wallets.every((w) => w.keyVersion === 'v2');
    assert.ok(check, 'all wallets re-encrypted to v2');

    const sample = cryptoService.decrypt(wallets[0].encryptedSecretKey);
    assert.equal(sample, `secret-key-${wallets[0].id}`);
  });

  test('interruption after batches resumes from checkpoint', async () => {
    const wallets = generateWallets(500, 1, 'v1');
    const prisma = createMockPrisma(wallets);
    const store = createCheckpointStore('memory');

    const controller = new AbortController();
    let batchCount = 0;

    const promise1 = rotateWalletKeysBatch({
      prisma,
      targetVersion: 'v2',
      batchSize: 100,
      checkpointStore: store,
      signal: controller.signal,
      onProgress: () => {
        batchCount++;
        if (batchCount === 200) {
          controller.abort();
        }
      },
    });

    const result1 = await promise1;
    assert.equal(result1.status, 'interrupted');
    assert.ok(result1.lastProcessedId);

    const cp = await store.getCheckpoint('v2');
    assert.ok(cp);
    assert.equal(cp.lastProcessedId, result1.lastProcessedId);

    // Second run: resumes from checkpoint
    const result2 = await rotateWalletKeysBatch({
      prisma,
      targetVersion: 'v2',
      batchSize: 100,
      checkpointStore: store,
    });

    assert.equal(result2.status, 'completed');
    assert.ok(wallets.every((w) => w.keyVersion === 'v2'));
  });

  test('dryRun mode does not modify database', async () => {
    const wallets = generateWallets(50, 1, 'v1');
    const prisma = createMockPrisma(wallets);
    const store = createCheckpointStore('memory');

    const originalCiphers = wallets.map((w) => w.encryptedSecretKey);

    const result = await rotateWalletKeysBatch({
      prisma,
      targetVersion: 'v2',
      batchSize: 20,
      checkpointStore: store,
      dryRun: true,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.rotatedCount, 50);
    assert.ok(wallets.every((w, i) => w.encryptedSecretKey === originalCiphers[i]));
    assert.ok(wallets.every((w) => w.keyVersion === 'v1'));
  });

  test('redacts secret keys on decryption error', async () => {
    const secretKeyStr = 'SAYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';
    const wallets = [
      {
        id: 'w-corrupt',
        publicKey: 'GBBB',
        encryptedSecretKey: `corrupted-ciphertext-containing-${secretKeyStr}`,
        keyVersion: 'v1',
      },
    ];
    const prisma = createMockPrisma(wallets);
    const store = createCheckpointStore('memory');

    const result = await rotateWalletKeysBatch({
      prisma,
      targetVersion: 'v2',
      batchSize: 10,
      checkpointStore: store,
    });

    assert.equal(result.failedCount, 1);
  });

  test('runKeyRotationJob executes and completes', async () => {
    const wallets = generateWallets(30, 1, 'v1');
    const prisma = createMockPrisma(wallets);
    const store = createCheckpointStore('memory');

    const result = await runKeyRotationJob({
      prisma,
      targetVersion: 'v2',
      batchSize: 10,
      checkpointStore: store,
    });

    assert.equal(result.status, 'completed');
    assert.ok(wallets.every((w) => w.keyVersion === 'v2'));
  });
});
