'use strict';

const path = require('path');
const {
  rotateWalletKeysBatch,
  createFileCheckpointStore,
  createRedisCheckpointStore,
} = require('../services/secret-rotation.service');
const { CURRENT_VERSION } = require('../services/crypto.service');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');

const KEY_ROTATION_JOB_NAME = 'wallet-key-rotation';
const DEFAULT_BATCH_SIZE = 100;

/**
 * Resolves a checkpoint store from options, Redis client, or a local checkpoint file path.
 */
const resolveCheckpointStore = ({ checkpointStore, redisClient, checkpointFile, checkpointKey } = {}) => {
  if (checkpointStore) return checkpointStore;
  if (redisClient) return createRedisCheckpointStore(redisClient, checkpointKey);
  if (checkpointFile) return createFileCheckpointStore(checkpointFile);
  return null;
};

/**
 * Executes the resumable wallet key rotation worker job.
 *
 * Processes wallets in batches of `batchSize` (default 100), persists checkpoints
 * after each batch, and gracefully handles SIGINT/SIGTERM when `attachSignalHandlers`
 * is enabled so an interrupted process can resume from the last processed wallet ID.
 */
const runKeyRotationJob = async ({
  db = prisma,
  targetVersion = CURRENT_VERSION,
  batchSize = DEFAULT_BATCH_SIZE,
  lastProcessedId = null,
  checkpointStore = null,
  redisClient = null,
  checkpointFile = process.env.KEY_ROTATION_CHECKPOINT_FILE || null,
  checkpointKey = process.env.KEY_ROTATION_CHECKPOINT_KEY || 'sendam:key-rotation:checkpoint',
  reencryptFn = null,
  useEnvelope = false,
  kmsProvider = null,
  dryRun = false,
  maxBatches = Infinity,
  abortSignal = null,
  attachSignalHandlers = false,
  actorId = 'key-rotation-worker',
  onBatchComplete = null,
} = {}) => {
  const store = resolveCheckpointStore({
    checkpointStore,
    redisClient,
    checkpointFile,
    checkpointKey,
  });

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  const onSignal = (sig) => {
    logger.warn('key_rotation_job_signal_received', { signal: sig });
    controller.abort();
  };

  if (attachSignalHandlers) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  logger.info('key_rotation_job_started', {
    jobName: KEY_ROTATION_JOB_NAME,
    targetVersion,
    batchSize,
    dryRun,
  });

  try {
    const report = await rotateWalletKeysBatch({
      db,
      targetVersion,
      batchSize,
      lastProcessedId,
      checkpointStore: store,
      reencryptFn,
      useEnvelope,
      kmsProvider,
      dryRun,
      maxBatches,
      abortSignal: controller.signal,
      actorId,
      onBatchComplete: async (progress) => {
        logger.info('key_rotation_batch_completed', progress);
        if (typeof onBatchComplete === 'function') {
          await onBatchComplete(progress);
        }
      },
    });

    logger.info('key_rotation_job_finished', {
      jobId: report.jobId,
      status: report.status,
      resumed: report.resumed,
      targetVersion: report.targetVersion,
      batchesProcessed: report.batchesProcessed,
      scannedCount: report.scannedCount,
      rotatedCount: report.rotatedCount,
      skippedCount: report.skippedCount,
      failedCount: report.failedCount,
      lastProcessedId: report.lastProcessedId,
      durationMs: report.durationMs,
    });

    return report;
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', forwardAbort);
    }
    if (attachSignalHandlers) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
};

/**
 * Registers the BullMQ job processor for automated wallet key rotation.
 */
const registerKeyRotationJob = (registerProcessorFn) => {
  const register = registerProcessorFn || require('../queues/queue.service').registerProcessor;
  return register(KEY_ROTATION_JOB_NAME, async (job) => {
    const data = job?.data || {};
    return runKeyRotationJob({
      targetVersion: data.targetVersion || CURRENT_VERSION,
      batchSize: Number(data.batchSize || DEFAULT_BATCH_SIZE),
      lastProcessedId: data.lastProcessedId || null,
      checkpointFile: data.checkpointFile || process.env.KEY_ROTATION_CHECKPOINT_FILE || null,
      checkpointKey: data.checkpointKey || process.env.KEY_ROTATION_CHECKPOINT_KEY || 'sendam:key-rotation:checkpoint',
      useEnvelope: Boolean(data.useEnvelope),
      dryRun: Boolean(data.dryRun),
      actorId: data.actorId || 'key-rotation-worker',
    });
  });
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const useEnvelope = args.includes('--envelope');
  const targetVerArg = args.find((a) => a.startsWith('--target-version='));
  const batchArg = args.find((a) => a.startsWith('--batch-size='));
  const checkpointArg = args.find((a) => a.startsWith('--checkpoint='));

  runKeyRotationJob({
    targetVersion: targetVerArg ? targetVerArg.split('=')[1] : CURRENT_VERSION,
    batchSize: batchArg ? Number(batchArg.split('=')[1]) || DEFAULT_BATCH_SIZE : DEFAULT_BATCH_SIZE,
    checkpointFile: checkpointArg
      ? path.resolve(checkpointArg.split('=')[1])
      : process.env.KEY_ROTATION_CHECKPOINT_FILE || null,
    useEnvelope,
    dryRun,
    attachSignalHandlers: true,
  })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.failedCount > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error('Key rotation job failed:', error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  KEY_ROTATION_JOB_NAME,
  DEFAULT_BATCH_SIZE,
  runKeyRotationJob,
  registerKeyRotationJob,
};
