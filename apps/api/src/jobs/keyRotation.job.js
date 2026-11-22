// Key Rotation Job
// Exposes a job to rotate wallet encryption keys in batches.

const { rotateWalletKeysBatch, createCheckpointStore } = require('../services/secret-rotation.service');
const { writeAuditLog } = require('../common/audit.service');

const JOB_NAME = 'wallet-key-rotation';

/**
 * Runs the wallet key rotation job.
 *
 * @param {object} params
 * @param {object} params.prisma Prisma client instance.
 * @param {string} params.targetVersion Target encryption version (e.g., 'v2').
 * @param {number} [params.batchSize=100] Number of wallets to process per batch.
 * @param {object} [params.checkpointStore] Optional checkpoint store; if omitted a memory store is used.
 * @param {boolean} [params.dryRun=false] When true, no database writes are performed.
 * @param {AbortSignal} [params.signal] Optional abort signal to interrupt processing.
 */
async function runKeyRotationJob({ prisma, targetVersion, batchSize = 100, checkpointStore = null, dryRun = false, signal = null }) {
  const store = checkpointStore ?? createCheckpointStore();
  let status = 'incomplete';
  let lastProcessedId = null;

  // Continue processing batches until completed or interrupted.
  while (true) {
    // Respect abort signal before starting a new batch.
    if (signal?.aborted) {
      status = 'interrupted';
      break;
    }

    // Run a batch.
    const result = await rotateWalletKeysBatch({
      prisma,
      targetVersion,
      batchSize,
      lastProcessedId,
      checkpointStore: store,
      dryRun,
      signal,
      onProgress: (_id) => {
        // Could be used for progress reporting; currently a no‑op.
      },
    });

    if (result.status === 'completed') {
      status = 'completed';
      break;
    }
    if (result.status === 'interrupted') {
      status = 'interrupted';
      break;
    }
    // Incomplete – continue with the next batch.
    lastProcessedId = result.lastProcessedId;
  }

  // Write an audit log entry summarising the job outcome.
  await writeAuditLog({
    actorType: 'system',
    action: 'secret.wallet_keys.rotated',
    entityType: 'SecretRotationJob',
    metadata: {
      jobName: JOB_NAME,
      targetVersion,
      status,
      lastProcessedId,
    },
  });

  return { status, lastProcessedId };
}

module.exports = { JOB_NAME, runKeyRotationJob };
