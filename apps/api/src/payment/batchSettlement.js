'use strict';

const { StellarSdk, server: defaultServer } = require('../config/stellar');
const config = require('../config/env');
const logger = require('../utils/logger');
const { assertValidAmount, add } = require('../utils/money');
const {
  validateAddress,
  resolveAsset,
  buildStellarMemo,
  getTransactionUrl,
  withAccountLock,
} = require('../wallet/stellar.adapter');
const { transitionPaymentState } = require('./payment.transitions');
const defaultPrisma = () => require('../common/prisma');
const { enqueue } = require('../queues/queue.service');

const MAX_OPERATIONS_PER_TRANSACTION = 100;
const QUEUE_NAME = 'batch-settlements';
const JOB_NAME = 'payment.batch_settle';

const validateBatchTransfers = (transfers) => {
  if (!Array.isArray(transfers) || transfers.length === 0) {
    throw new Error('Batch transfers list must contain at least 1 transfer.');
  }

  if (transfers.length > MAX_OPERATIONS_PER_TRANSACTION) {
    throw new Error(`Batch transfers list exceeds maximum of ${MAX_OPERATIONS_PER_TRANSACTION} operations per transaction.`);
  }

  return transfers.map((transfer, index) => {
    if (!transfer || typeof transfer !== 'object') {
      throw new Error(`Transfer at index ${index} must be a valid object.`);
    }

    const { destination, amount, asset, recipientId, id } = transfer;

    if (!destination || !validateAddress(String(destination).trim())) {
      throw new Error(`Transfer at index ${index} has an invalid Stellar destination address: ${destination}`);
    }

    const effectiveAsset = asset || 'XLM';
    const normalizedAmount = assertValidAmount(amount, effectiveAsset);

    return {
      id: id || recipientId || `tx_batch_${index}_${Date.now()}`,
      destination: String(destination).trim(),
      amount: normalizedAmount,
      asset: effectiveAsset,
      recipientId: recipientId || null,
    };
  });
};

const buildBatchPaymentTransaction = ({
  sourceAccount,
  transfers,
  baseFee,
  networkPassphrase = config.stellar.network === 'testnet' ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC,
  memo,
  memoType,
}) => {
  const validatedTransfers = validateBatchTransfers(transfers);
  const feePerOp = baseFee != null ? String(baseFee) : '100';

  const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: feePerOp,
    networkPassphrase,
  });

  const stellarMemo = buildStellarMemo({ memo, memoType });
  if (stellarMemo) {
    builder.addMemo(stellarMemo);
  }

  for (const transfer of validatedTransfers) {
    const assetInstance = resolveAsset(transfer.asset);
    const operation = StellarSdk.Operation.payment({
      destination: transfer.destination,
      asset: assetInstance,
      amount: transfer.amount,
    });
    builder.addOperation(operation);
  }

  return builder.setTimeout(30).build();
};

const executeBatchSettlement = async ({
  secretKey,
  sourcePublicKey,
  signer,
  transfers,
  memo,
  memoType,
  horizonServer,
  networkPassphrase,
  prisma = defaultPrisma(),
}) => {
  const server = horizonServer || defaultServer;
  const validatedTransfers = validateBatchTransfers(transfers);

  let sourceKeypair;
  let effectiveSourcePublicKey = sourcePublicKey;

  if (secretKey) {
    sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
    effectiveSourcePublicKey = sourceKeypair.publicKey();
  } else if (signer?.publicKey) {
    effectiveSourcePublicKey = signer.publicKey;
  } else if (!effectiveSourcePublicKey) {
    throw new Error('Either secretKey, signer, or sourcePublicKey is required for batch settlement.');
  }

  return withAccountLock(effectiveSourcePublicKey, async () => {
    const baseFee = await server.fetchBaseFee();
    const sourceAccount = await server.loadAccount(effectiveSourcePublicKey);

    const transaction = buildBatchPaymentTransaction({
      sourceAccount,
      transfers: validatedTransfers,
      baseFee,
      networkPassphrase,
      memo,
      memoType,
    });

    if (sourceKeypair) {
      transaction.sign(sourceKeypair);
    } else if (signer && typeof signer.signTransaction === 'function') {
      await signer.signTransaction(transaction);
    } else {
      throw new Error('No signing mechanism available for batch transaction.');
    }

    const txResponse = await server.submitTransaction(transaction);
    const txHash = txResponse.hash;
    const explorerUrl = getTransactionUrl(txHash);

    const updateRecord = async (db, transfer) => {
      if (transfer.id && db?.transaction?.findUnique) {
        const existing = await db.transaction.findUnique({ where: { id: transfer.id } }).catch(() => null);
        if (existing) {
          await transitionPaymentState({
            db,
            transactionId: transfer.id,
            fromState: [existing.status],
            toState: 'success',
            actor: { type: 'system', id: 'batch_settlement_worker' },
            reason: 'Settled in multi-recipient batch transaction',
            extraData: {
              txHash,
              explorerUrl,
              batchSize: validatedTransfers.length,
            },
          }).catch(() => {});
        }
      }
    };

    if (prisma && prisma.$transaction) {
      await prisma.$transaction(async (tx) => {
        for (const transfer of validatedTransfers) {
          await updateRecord(tx, transfer);
        }
      }).catch((err) => {
        logger.warn('batch_settlement_db_record_update_failed', { error: err.message });
      });
    } else if (prisma) {
      for (const transfer of validatedTransfers) {
        await updateRecord(prisma, transfer);
      }
    }

    const totalAmountByAsset = validatedTransfers.reduce((acc, t) => {
      acc[t.asset] = acc[t.asset] ? add(acc[t.asset], t.amount, t.asset) : t.amount;
      return acc;
    }, {});

    logger.info('batch_settlement_executed', {
      txHash,
      recipientCount: validatedTransfers.length,
      totals: totalAmountByAsset,
    });

    return {
      success: true,
      txHash,
      explorerUrl,
      recipientCount: validatedTransfers.length,
      ledger: txResponse.ledger || null,
      totals: totalAmountByAsset,
      transfers: validatedTransfers,
    };
  });
};

const enqueueBatchSettlement = async ({
  batchId,
  secretKey,
  sourcePublicKey,
  transfers,
  memo,
  memoType,
  enqueueFn = enqueue,
}) => {
  validateBatchTransfers(transfers);
  const id = batchId || `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return enqueueFn(QUEUE_NAME, JOB_NAME, {
    batchId: id,
    secretKey,
    sourcePublicKey,
    transfers,
    memo,
    memoType,
  }, {
    jobId: id,
    priority: 1,
    attempts: 3,
  });
};

const processBatchSettlementJob = async (job, deps = {}) => {
  const { secretKey, sourcePublicKey, transfers, memo, memoType } = job.data || {};
  return executeBatchSettlement({
    secretKey,
    sourcePublicKey,
    transfers,
    memo,
    memoType,
    horizonServer: deps.horizonServer,
    networkPassphrase: deps.networkPassphrase,
    prisma: deps.prisma,
  });
};

module.exports = {
  MAX_OPERATIONS_PER_TRANSACTION,
  QUEUE_NAME,
  JOB_NAME,
  validateBatchTransfers,
  buildBatchPaymentTransaction,
  executeBatchSettlement,
  enqueueBatchSettlement,
  processBatchSettlementJob,
};
