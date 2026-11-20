'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY_V1 = 'a'.repeat(64);
const KEY_V2 = 'b'.repeat(64);
process.env.ENCRYPTION_KEY = KEY_V1;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-at-least-32-chars';

const srcRoot = path.resolve(__dirname, '../src');
const auditAbs = path.resolve(srcRoot, 'common/audit.service.js');
require.cache[auditAbs] = {
  id: auditAbs,
  filename: auditAbs,
  loaded: true,
  exports: { writeAuditLog: async () => {} },
};

const { encrypt, decrypt, registerKeyVersion } = require('../src/services/crypto.service');
const {
  rotateWalletKeysBatch,
  createMemoryCheckpointStore,
  createFileCheckpointStore,
  createRedisCheckpointStore,
} = require('../src/services/secret-rotation.service');
const {
  KEY_ROTATION_JOB_NAME,
  runKeyRotationJob,
  registerKeyRotationJob,
} = require('../src/jobs/keyRotation.job');

registerKeyVersion('v1', KEY_V1);
registerKeyVersion('v2', KEY_V2);

/**
 * In-memory Prisma wallet table emulator supporting cursor pagination (`id: { gt }`)
 * and `keyVersion !== targetVersion` filtering at 10,000+ row scale.
 */
const createFakeWalletDb = (count, { initialVersion = 'v1', corruptIds = new Set() } = {}) => {
  const wallets = [];
  const sampleSecret = 'SAEXAMPLESECRETKEYVALUE123456789012345678901234567890123';
  // Pre-encrypt one v1 ciphertext to keep 10,000-row setup under 50ms while still running real AES-256-GCM in rotation
  const baseEncrypted = encrypt(sampleSecret, initialVersion);

  for (let i = 1; i <= count; i += 1) {
    const id = `w_${String(i).padStart(6, '0')}`;
    wallets.push({
      id,
      publicKey: `G_PUB_${id}`,
      encryptedSecretKey: corruptIds.has(id) ? 'malformed-ciphertext' : baseEncrypted,
      keyVersion: initialVersion,
    });
  }

  const byId = new Map(wallets.map((w) => [w.id, w]));
  let updateCalls = 0;

  const db = {
    wallet: {
      findMany: async ({ where = {}, take = 100 } = {}) => {
        const targetNot = where.OR?.find((c) => c.keyVersion?.not)?.keyVersion?.not;
        const gtId = where.id?.gt || null;

        const results = [];
        for (const w of wallets) {
          if (w.encryptedSecretKey == null) continue;
          if (gtId && !(w.id > gtId)) continue;
          if (targetNot && w.keyVersion === targetNot) continue;
          results.push({ ...w });
          if (results.length >= take) break;
        }
        return results;
      },
      update: async ({ where, data }) => {
        const row = byId.get(where.id);
        if (!row) throw new Error(`Wallet ${where.id} not found`);
        Object.assign(row, data);
        updateCalls += 1;
        return { ...row };
      },
    },
  };

  return { db, wallets, sampleSecret, getUpdateCalls: () => updateCalls };
};

describe('Automated Resumable Key Rotation Worker (#956)', () => {
  test('re-encrypts 10,000 wallets in batches of 100 and updates keyVersion to v2', async () => {
    const { db, wallets, sampleSecret, getUpdateCalls } = createFakeWalletDb(10000);
    const checkpointStore = createMemoryCheckpointStore();

    const report = await runKeyRotationJob({
      db,
      targetVersion: 'v2',
      batchSize: 100,
      checkpointStore,
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.batchesProcessed, 100);
    assert.equal(report.scannedCount, 10000);
    assert.equal(report.rotatedCount, 10000);
    assert.equal(report.failedCount, 0);
    assert.equal(report.lastProcessedId, 'w_010000');
    assert.equal(getUpdateCalls(), 10000);

    // Verify all rows are now v2 and spot-check decryption integrity
    assert.ok(wallets.every((w) => w.keyVersion === 'v2' && w.encryptedSecretKey.startsWith('v2:')));
    assert.equal(decrypt(wallets[0].encryptedSecretKey), sampleSecret);
    assert.equal(decrypt(wallets[4999].encryptedSecretKey), sampleSecret);
    assert.equal(decrypt(wallets[9999].encryptedSecretKey), sampleSecret);
  });

  test('survives mid-run process interruption and resumes from lastProcessedId without duplicate work', async () => {
    const { db, wallets, getUpdateCalls } = createFakeWalletDb(1000);
    const checkpointStore = createMemoryCheckpointStore();
    const abortController = new AbortController();

    // First run: abort cleanly right after batch 4 (400 wallets processed)
    const firstRun = await runKeyRotationJob({
      db,
      targetVersion: 'v2',
      batchSize: 100,
      checkpointStore,
      abortSignal: abortController.signal,
      onBatchComplete: ({ batchNumber }) => {
        if (batchNumber === 4) {
          abortController.abort();
        }
      },
    });

    assert.equal(firstRun.status, 'interrupted');
    assert.equal(firstRun.batchesProcessed, 4);
    assert.equal(firstRun.rotatedCount, 400);
    assert.equal(firstRun.lastProcessedId, 'w_000400');
    assert.equal(getUpdateCalls(), 400);

    // Second run: resumes automatically from saved checkpoint (w_000400)
    const secondRun = await runKeyRotationJob({
      db,
      targetVersion: 'v2',
      batchSize: 100,
      checkpointStore,
    });

    assert.equal(secondRun.resumed, true);
    assert.equal(secondRun.status, 'completed');
    assert.equal(secondRun.jobId, firstRun.jobId);
    assert.equal(secondRun.batchesProcessed, 10);
    assert.equal(secondRun.rotatedCount, 1000);
    assert.equal(secondRun.lastProcessedId, 'w_001000');
    // Total DB updates across both runs equals exactly 1,000 (no re-processing of first 400)
    assert.equal(getUpdateCalls(), 1000);
    assert.ok(wallets.every((w) => w.keyVersion === 'v2'));
  });

  test('persists checkpoints safely with file-backed and Redis-backed checkpoint stores', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sendam-krot-'));
    const checkpointFile = path.join(tmpDir, 'rotation.checkpoint.json');

    try {
      const fileStore = createFileCheckpointStore(checkpointFile);
      assert.equal(await fileStore.load(), null);
      await fileStore.save({ jobId: 'job-1', lastProcessedId: 'w_000200', status: 'in_progress' });
      const loaded = await fileStore.load();
      assert.equal(loaded.lastProcessedId, 'w_000200');
      await fileStore.clear();
      assert.equal(await fileStore.load(), null);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }

    const kv = new Map();
    const fakeRedis = {
      get: async (k) => kv.get(k) || null,
      set: async (k, v) => { kv.set(k, v); },
      del: async (k) => { kv.delete(k); },
    };
    const redisStore = createRedisCheckpointStore(fakeRedis, 'test:krot');
    await redisStore.save({ jobId: 'job-2', lastProcessedId: 'w_000500', status: 'in_progress' });
    assert.equal((await redisStore.load()).lastProcessedId, 'w_000500');
    await redisStore.clear();
    assert.equal(await redisStore.load(), null);
  });

  test('isolates per-wallet failures, redacts Stellar secret keys, and supports dry-run', async () => {
    const { db, getUpdateCalls } = createFakeWalletDb(5, { corruptIds: new Set(['w_000003']) });

    const dryReport = await rotateWalletKeysBatch({
      db,
      targetVersion: 'v2',
      batchSize: 2,
      dryRun: true,
    });
    assert.equal(dryReport.rotatedCount, 5);
    assert.equal(getUpdateCalls(), 0);

    const report = await rotateWalletKeysBatch({
      db,
      targetVersion: 'v2',
      batchSize: 2,
      dryRun: false,
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.rotatedCount, 4);
    assert.equal(report.failedCount, 1);
    assert.equal(report.errors[0].walletId, 'w_000003');
  });

  test('registers BullMQ key rotation job processor', async () => {
    let registeredName = null;
    let registeredHandler = null;
    registerKeyRotationJob((name, handler) => {
      registeredName = name;
      registeredHandler = handler;
    });

    assert.equal(registeredName, KEY_ROTATION_JOB_NAME);
    assert.equal(typeof registeredHandler, 'function');
  });
});
