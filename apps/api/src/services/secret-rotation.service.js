const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const { writeAuditLog } = require('../common/audit.service');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const {
  CURRENT_VERSION,
  decrypt,
  encrypt,
  decryptEnvelope,
  encryptEnvelope,
  isEnvelopeCiphertext,
} = require('./crypto.service');

const SECRET_CATEGORIES = Object.freeze({
  ENCRYPTION_KEY: 'encryption_key',
  JWT_SECRET: 'jwt_secret',
  PIN_PEPPER: 'pin_pepper',
  WHATSAPP_APP_SECRET: 'whatsapp_app_secret',
  METRICS_TOKEN: 'metrics_token',
  ERROR_MONITOR_TOKEN: 'error_monitor_token',
  COINGECKO_API_KEY: 'coingecko_api_key',
  EXCHANGERATE_API_KEY: 'exchangerate_api_key',
  SMILE_ID_API_KEY: 'smile_id_api_key',
  DOJAH_SECRET_KEY: 'dojah_secret_key',
  DEEPGRAM_API_KEY: 'deepgram_api_key',
  WHISPER_API_KEY: 'whisper_api_key',
  STELLAR_AUTH_SIGNING_KEY: 'stellar_auth_signing_key',
});

const ROTATION_CADENCE_DAYS = Object.freeze({
  ENCRYPTION_KEY: 90,
  JWT_SECRET: 90,
  PIN_PEPPER: 180,
  WHATSAPP_APP_SECRET: 365,
  METRICS_TOKEN: 365,
  ERROR_MONITOR_TOKEN: 365,
  COINGECKO_API_KEY: 180,
  EXCHANGERATE_API_KEY: 180,
  SMILE_ID_API_KEY: 90,
  DOJAH_SECRET_KEY: 90,
  DEEPGRAM_API_KEY: 180,
  WHISPER_API_KEY: 180,
  STELLAR_AUTH_SIGNING_KEY: 365,
});

const ROTATION_OWNERS = Object.freeze({
  ENCRYPTION_KEY: 'security',
  JWT_SECRET: 'security',
  PIN_PEPPER: 'compliance',
  WHATSAPP_APP_SECRET: 'operations',
  METRICS_TOKEN: 'operations',
  ERROR_MONITOR_TOKEN: 'operations',
  COINGECKO_API_KEY: 'operations',
  EXCHANGERATE_API_KEY: 'operations',
  SMILE_ID_API_KEY: 'compliance',
  DOJAH_SECRET_KEY: 'compliance',
  DEEPGRAM_API_KEY: 'operations',
  WHISPER_API_KEY: 'operations',
  STELLAR_AUTH_SIGNING_KEY: 'security',
});

const generateSecretValue = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

const getSecretHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

const getRotationDueDate = (category, lastRotatedAt) => {
  const cadenceDays = ROTATION_CADENCE_DAYS[category] || 365;
  const last = lastRotatedAt ? new Date(lastRotatedAt) : new Date(0);
  return new Date(last.getTime() + cadenceDays * 24 * 60 * 60 * 1000);
};

const isRotationExpiringSoon = (dueDate, warningDays = 30) => {
  const now = new Date();
  const warningThreshold = new Date(now.getTime() + warningDays * 24 * 60 * 60 * 1000);
  return dueDate <= warningThreshold;
};

const evaluateRotationHealth = async () => {
  const now = new Date();
  const results = [];
  const alertWebhookUrl = config.observability?.errorMonitorWebhookUrl;
  const alertToken = config.observability?.errorMonitorToken;

  for (const [category, owner] of Object.entries(ROTATION_OWNERS)) {
    const dueDate = getRotationDueDate(category, null);
    const expiringSoon = isRotationExpiringSoon(dueDate, 30);
    const expired = dueDate < now;

    results.push({
      category,
      owner,
      dueDate: dueDate.toISOString(),
      status: expired ? 'expired' : expiringSoon ? 'expiring_soon' : 'ok',
      cadenceDays: ROTATION_CADENCE_DAYS[category] || 365,
    });

    if (expired || expiringSoon) {
      const alertPayload = {
        text: `[Secret Rotation] ${category} is ${expired ? 'EXPIRED' : 'expiring soon'}. Owner: ${owner}. Due: ${dueDate.toISOString()}`,
        level: expired ? 'critical' : 'warning',
        category,
        owner,
        dueDate: dueDate.toISOString(),
      };

      if (alertWebhookUrl) {
        try {
          const axios = require('axios');
          await axios.post(alertWebhookUrl, alertPayload, {
            headers: {
              'Content-Type': 'application/json',
              ...(alertToken ? { Authorization: `Bearer ${alertToken}` } : {}),
            },
            timeout: config.observability?.errorMonitorTimeoutMs || 3000,
          });
        } catch (error) {
          logger.warn(`Failed to send secret rotation alert for ${category}: ${error.message}`);
        }
      }
    }
  }

  await writeAuditLog({
    actorType: 'system',
    action: 'secret.rotation.health_check',
    entityType: 'SecretRotation',
    metadata: { evaluatedAt: now.toISOString(), results, alertWebhookConfigured: Boolean(alertWebhookUrl) },
  });

  return results;
};

const rotateSecret = async ({ category, newValue, rotatedBy }) => {
  if (!SECRET_CATEGORIES[category]) {
    throw Object.assign(new Error(`Unknown secret category: ${category}`), { statusCode: 400 });
  }

  const hash = getSecretHash(newValue);
  const now = new Date();

  await prisma.secretRotation.create({
    data: {
      category,
      hash,
      rotatedBy: rotatedBy || 'system',
      rotatedAt: now,
      expiresAt: getRotationDueDate(category, now),
    },
  });

  await writeAuditLog({
    actorType: 'administrator',
    actorId: rotatedBy || 'system',
    action: 'secret.rotation.completed',
    entityType: 'SecretRotation',
    metadata: { category, expiresAt: getRotationDueDate(category, now).toISOString() },
  });

  return { category, hash, rotatedAt: now.toISOString(), expiresAt: getRotationDueDate(category, now).toISOString() };
};

const getRotationStatus = async () => {
  const rotations = await prisma.secretRotation.findMany({
    orderBy: { rotatedAt: 'desc' },
    take: 100,
  });

  const health = await evaluateRotationHealth();

  return {
    rotations: rotations.map((r) => ({
      id: r.id,
      category: r.category,
      rotatedBy: r.rotatedBy,
      rotatedAt: r.rotatedAt,
      expiresAt: r.expiresAt,
      hash: r.hash,
    })),
    health,
  };
};

const redactSecretKeys = (message) => String(message || 'Unknown rotation error')
  .replace(/S[A-Z2-7]{55}/g, '[REDACTED_SECRET]');

/**
 * In-memory checkpoint store for resumable wallet key rotation (tests / ephemeral runs).
 */
const createMemoryCheckpointStore = (initialState = null) => {
  let state = initialState ? { ...initialState } : null;
  return {
    load: async () => (state ? { ...state } : null),
    save: async (checkpoint) => {
      state = { ...checkpoint, updatedAt: new Date().toISOString() };
      return state;
    },
    clear: async () => {
      state = null;
    },
  };
};

/**
 * File-backed checkpoint store using atomic rename so process crashes never corrupt progress.
 */
const createFileCheckpointStore = (filePath) => {
  if (!filePath) {
    throw new Error('Checkpoint filePath is required for createFileCheckpointStore.');
  }
  return {
    load: async () => {
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(raw);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    save: async (checkpoint) => {
      const payload = { ...checkpoint, updatedAt: new Date().toISOString() };
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      await fs.promises.rename(tmpPath, filePath);
      return payload;
    },
    clear: async () => {
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
};

/**
 * Redis-backed checkpoint store for multi-worker / containerized deployments.
 */
const createRedisCheckpointStore = (redisClient, key = 'sendam:key-rotation:checkpoint') => {
  if (!redisClient) {
    throw new Error('redisClient is required for createRedisCheckpointStore.');
  }
  return {
    load: async () => {
      const raw = await redisClient.get(key);
      return raw ? JSON.parse(raw) : null;
    },
    save: async (checkpoint) => {
      const payload = { ...checkpoint, updatedAt: new Date().toISOString() };
      await redisClient.set(key, JSON.stringify(payload));
      return payload;
    },
    clear: async () => {
      await redisClient.del(key);
    },
  };
};

const isCiphertextAtVersion = (ciphertext, targetVersion) => {
  if (!ciphertext || typeof ciphertext !== 'string') return false;
  if (ciphertext.startsWith('env:v1:') || ciphertext.startsWith('kms:v1:')) {
    const parts = ciphertext.split(':');
    return parts[3] === targetVersion;
  }
  const parts = ciphertext.split(':');
  return parts.length === 4 && parts[0] === targetVersion;
};

const defaultReencryptWalletSecret = async (encryptedSecretKey, targetVersion, { useEnvelope = false, kmsProvider = null } = {}) => {
  if (useEnvelope || isEnvelopeCiphertext(encryptedSecretKey)) {
    const plaintext = await decryptEnvelope(encryptedSecretKey, kmsProvider ? { provider: kmsProvider } : {});
    const envelope = await encryptEnvelope(plaintext, {
      keyVersion: targetVersion,
      ...(kmsProvider ? { provider: kmsProvider } : {}),
    });
    return envelope.serialized;
  }
  const plaintext = decrypt(encryptedSecretKey);
  return encrypt(plaintext, targetVersion);
};

/**
 * Resumable, cursor-paginated batch wallet key rotation engine (#956).
 *
 * Reads wallets whose `keyVersion !== targetVersion` (or `null`) in deterministic
 * ascending `id` order using `id > lastProcessedId`, re-encrypts each wallet's
 * secret key under `targetVersion`, and persists a checkpoint after every batch.
 * Survives process crashes or `abortSignal` interruptions and resumes cleanly
 * from `lastProcessedId`.
 */
const rotateWalletKeysBatch = async ({
  db = prisma,
  targetVersion = CURRENT_VERSION,
  batchSize = 100,
  lastProcessedId = null,
  checkpointStore = null,
  reencryptFn = null,
  useEnvelope = false,
  kmsProvider = null,
  dryRun = false,
  maxBatches = Infinity,
  abortSignal = null,
  actorId = 'system',
  onBatchComplete = null,
} = {}) => {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer.');
  }

  const startTime = Date.now();
  const savedCheckpoint = checkpointStore ? await checkpointStore.load() : null;
  const resumed = Boolean(
    savedCheckpoint
    && savedCheckpoint.targetVersion === targetVersion
    && savedCheckpoint.status !== 'completed'
    && savedCheckpoint.lastProcessedId,
  );

  let cursor = lastProcessedId || (resumed ? savedCheckpoint.lastProcessedId : null);
  const jobId = (resumed && savedCheckpoint.jobId) || `krot_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  const report = {
    jobId,
    status: 'in_progress',
    resumed,
    targetVersion,
    batchSize,
    dryRun,
    lastProcessedId: cursor,
    batchesProcessed: resumed ? Number(savedCheckpoint.batchesProcessed || 0) : 0,
    scannedCount: resumed ? Number(savedCheckpoint.scannedCount || 0) : 0,
    rotatedCount: resumed ? Number(savedCheckpoint.rotatedCount || 0) : 0,
    skippedCount: resumed ? Number(savedCheckpoint.skippedCount || 0) : 0,
    failedCount: resumed ? Number(savedCheckpoint.failedCount || 0) : 0,
    durationMs: 0,
    errors: [],
  };

  let batchesInThisRun = 0;

  while (batchesInThisRun < maxBatches) {
    if (abortSignal?.aborted) {
      report.status = 'interrupted';
      break;
    }

    const where = {
      encryptedSecretKey: { not: null },
      OR: [
        { keyVersion: { not: targetVersion } },
        { keyVersion: null },
      ],
      ...(cursor ? { id: { gt: cursor } } : {}),
    };

    const batch = await db.wallet.findMany({
      where,
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        publicKey: true,
        encryptedSecretKey: true,
        keyVersion: true,
      },
    });

    if (!batch || batch.length === 0) {
      report.status = 'completed';
      break;
    }

    let batchRotated = 0;
    let batchSkipped = 0;
    let batchFailed = 0;

    for (const wallet of batch) {
      if (abortSignal?.aborted) {
        report.status = 'interrupted';
        break;
      }

      report.scannedCount += 1;

      if (wallet.keyVersion === targetVersion && isCiphertextAtVersion(wallet.encryptedSecretKey, targetVersion)) {
        report.skippedCount += 1;
        batchSkipped += 1;
        cursor = wallet.id;
        report.lastProcessedId = cursor;
        continue;
      }

      if (dryRun) {
        report.rotatedCount += 1;
        batchRotated += 1;
        cursor = wallet.id;
        report.lastProcessedId = cursor;
        continue;
      }

      try {
        const newCiphertext = reencryptFn
          ? await reencryptFn(wallet, targetVersion)
          : await defaultReencryptWalletSecret(wallet.encryptedSecretKey, targetVersion, { useEnvelope, kmsProvider });

        await db.wallet.update({
          where: { id: wallet.id },
          data: {
            encryptedSecretKey: newCiphertext,
            keyVersion: targetVersion,
          },
        });

        report.rotatedCount += 1;
        batchRotated += 1;
      } catch (error) {
        report.failedCount += 1;
        batchFailed += 1;
        const safeMessage = redactSecretKeys(error?.message);
        report.errors.push({
          walletId: wallet.id,
          publicKey: wallet.publicKey,
          error: safeMessage,
        });
        logger.error('wallet_key_rotation_failed', {
          jobId,
          walletId: wallet.id,
          error: safeMessage,
        });
      }

      cursor = wallet.id;
      report.lastProcessedId = cursor;
    }

    report.batchesProcessed += 1;
    batchesInThisRun += 1;

    if (checkpointStore && !dryRun) {
      await checkpointStore.save({
        jobId,
        status: report.status === 'interrupted' ? 'interrupted' : 'in_progress',
        targetVersion,
        batchSize,
        lastProcessedId: report.lastProcessedId,
        batchesProcessed: report.batchesProcessed,
        scannedCount: report.scannedCount,
        rotatedCount: report.rotatedCount,
        skippedCount: report.skippedCount,
        failedCount: report.failedCount,
      });
    }

    if (typeof onBatchComplete === 'function') {
      await onBatchComplete({
        jobId,
        batchNumber: report.batchesProcessed,
        batchSize: batch.length,
        batchRotated,
        batchSkipped,
        batchFailed,
        lastProcessedId: report.lastProcessedId,
      });
    }

    if (report.status === 'interrupted') {
      break;
    }

    if (batch.length < batchSize) {
      report.status = 'completed';
      break;
    }
  }

  if (report.status === 'in_progress') {
    report.status = 'paused';
  }

  report.durationMs = Date.now() - startTime;

  if (checkpointStore && !dryRun) {
    await checkpointStore.save({
      jobId,
      status: report.status,
      targetVersion,
      batchSize,
      lastProcessedId: report.lastProcessedId,
      batchesProcessed: report.batchesProcessed,
      scannedCount: report.scannedCount,
      rotatedCount: report.rotatedCount,
      skippedCount: report.skippedCount,
      failedCount: report.failedCount,
    });
  }

  await writeAuditLog({
    actorType: 'system',
    actorId: String(actorId),
    action: `secret.wallet_rotation.${report.status}`,
    entityType: 'SecretRotation',
    entityId: jobId,
    metadata: {
      targetVersion,
      batchSize,
      dryRun,
      resumed,
      lastProcessedId: report.lastProcessedId,
      batchesProcessed: report.batchesProcessed,
      scannedCount: report.scannedCount,
      rotatedCount: report.rotatedCount,
      skippedCount: report.skippedCount,
      failedCount: report.failedCount,
      durationMs: report.durationMs,
    },
  });

  return report;
};

module.exports = {
  SECRET_CATEGORIES,
  ROTATION_CADENCE_DAYS,
  ROTATION_OWNERS,
  evaluateRotationHealth,
  rotateSecret,
  getRotationStatus,
  generateSecretValue,
  getSecretHash,
  getRotationDueDate,
  isRotationExpiringSoon,
  rotateWalletKeysBatch,
  createMemoryCheckpointStore,
  createFileCheckpointStore,
  createRedisCheckpointStore,
  redactSecretKeys,
};
