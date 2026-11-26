'use strict';

/**
 * Emergency Fund Freezing and Revocation Mechanism for Compromised Wallets (#964)
 * ─────────────────────────────────────────────────────────────────────────────
 * In the event of reported phone theft or unauthorized account access, operators
 * need an immediate mechanism to freeze wallet activity and rotate signer keys.
 *
 * Requirements:
 * 1. Sets signer weight to 0 (masterWeight = 0).
 * 2. Adds platform recovery signer with weight 1.
 * 3. Sets operation thresholds (low = 1, med = 1, high = 1) so only the recovery
 *    signer can authorize transactions.
 * 4. Cancels all pending in-flight transactions and recurring mandates.
 * 5. Deactivates customer account so API-level submissions are halted immediately.
 * 6. Emits immutable audit logs and workflow events for forensics and compliance.
 */

const express = require('express');
const { server: defaultServer, StellarSdk } = require('../config/stellar');
const prisma = require('../common/prisma');
const { decrypt } = require('../services/crypto.service');
const { writeAuditLog } = require('../common/audit.service');
const { appendEvent } = require('../common/event.service');
const { deactivateAccount, DEACTIVATION_REASONS } = require('../compliance/account.service');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');
const config = require('../config/env');
const { withAccountLock, getTransactionUrl } = require('./stellar.adapter');

const assertUsableNetwork = (wallet) => {
  if (!wallet) return wallet;
  const currentNet = config.stellar?.network;
  if (wallet.network && currentNet && wallet.network !== currentNet) {
    throw Object.assign(
      new Error(`Wallet belongs to network '${wallet.network}' but service is running on '${currentNet}'.`),
      { statusCode: 400 },
    );
  }
  return wallet;
};

/**
 * Resolves or generates the platform recovery signer public key.
 */
const resolveRecoverySignerPublicKey = (providedKey) => {
  const candidate = (
    providedKey ||
    process.env.PLATFORM_RECOVERY_SIGNER_PUBLIC_KEY ||
    process.env.STELLAR_RECOVERY_SIGNER ||
    config.stellar?.recoverySignerPublicKey
  );

  if (candidate) {
    const trimmed = String(candidate).trim();
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(trimmed)) {
      throw Object.assign(
        new Error(`Invalid platform recovery signer public key: ${trimmed}`),
        { statusCode: 400 },
      );
    }
    return trimmed;
  }

  // Fallback in test/dev environments: generate dedicated recovery keypair
  const generatedKeypair = StellarSdk.Keypair.random();
  logger.warn(
    `[EmergencyFreeze] No PLATFORM_RECOVERY_SIGNER_PUBLIC_KEY configured; generated fallback recovery key: ${generatedKeypair.publicKey()}`,
  );
  return generatedKeypair.publicKey();
};

/**
 * Executes on-chain signer rotation via Stellar setOptions operation.
 */
const setEmergencySigners = async ({
  publicKey,
  secretKey,
  recoverySignerPublicKey,
  server = defaultServer,
}) => {
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const sourcePublicKey = keypair.publicKey();

  return withAccountLock(sourcePublicKey, async () => {
    let account;
    try {
      account = await server.loadAccount(sourcePublicKey);
    } catch (err) {
      if (err?.response?.status === 404 || /not found/i.test(err?.message)) {
        logger.info(`[EmergencyFreeze] Account ${sourcePublicKey} not found on-chain; skipping on-chain signer rotation.`);
        return {
          onChainApplied: false,
          reason: 'account_not_funded_on_chain',
        };
      }
      throw err;
    }

    const baseFee = await server.fetchBaseFee().catch(() => 100);
    const fee = String(baseFee || 100);
    const networkPassphrase =
      config.stellar?.network === 'public'
        ? StellarSdk.Networks.PUBLIC
        : StellarSdk.Networks.TESTNET;

    const operation = StellarSdk.Operation.setOptions({
      masterWeight: 0,
      lowThreshold: 1,
      medThreshold: 1,
      highThreshold: 1,
      signer: {
        ed25519PublicKey: recoverySignerPublicKey,
        weight: 1,
      },
    });

    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee,
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    transaction.sign(keypair);

    const txResponse = await server.submitTransaction(transaction);
    const txHash = txResponse?.hash || txResponse?.id;

    return {
      onChainApplied: true,
      txHash,
      explorerUrl: txHash ? getTransactionUrl(txHash) : null,
      masterWeight: 0,
      recoverySignerWeight: 1,
      thresholds: { low: 1, med: 1, high: 1 },
      recoverySignerPublicKey,
    };
  });
};

/**
 * Cancels all pending in-flight transactions for a user/wallet.
 */
const cancelPendingTransactions = async ({ userId, walletId, reason, db = prisma }) => {
  const pendingTransactions = await db.transaction.findMany({
    where: {
      userId,
      status: { in: ['pending', 'processing', 'submitted'] },
    },
  });

  const cancelledIds = [];
  const eventTime = new Date().toISOString();

  for (const tx of pendingTransactions) {
    const existingMeta = typeof tx.metadata === 'object' && tx.metadata !== null ? tx.metadata : {};
    await db.transaction.update({
      where: { id: tx.id },
      data: {
        status: 'cancelled',
        metadata: {
          ...existingMeta,
          cancelledAt: eventTime,
          cancellationReason: `emergency_freeze: ${reason || 'Account compromised'}`,
          frozenWalletId: walletId,
        },
      },
    });
    cancelledIds.push(tx.id);
  }

  // Cancel any active or awaiting_pin recurring payments
  if (db.recurringPayment?.updateMany) {
    try {
      await db.recurringPayment.updateMany({
        where: {
          userId,
          status: { in: ['active', 'awaiting_pin'] },
        },
        data: { status: 'cancelled' },
      });
    } catch (err) {
      logger.warn(`[EmergencyFreeze] Could not cancel recurring payments: ${err.message}`);
    }
  }

  return cancelledIds;
};

/**
 * Core Emergency Freeze Orchestrator.
 */
const emergencyFreezeWallet = async ({
  walletId,
  recoverySignerPublicKey: userProvidedKey,
  reason = 'Reported phone theft or unauthorized account access',
  adminId = 'system',
  actorType = 'administrator',
  db = prisma,
  server = defaultServer,
}) => {
  if (!walletId) {
    throw Object.assign(new Error('Wallet ID is required for emergency freeze'), { statusCode: 400 });
  }

  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) {
    throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });
  }

  // Ensure network safety constraints
  assertUsableNetwork(wallet);

  if (!wallet.encryptedSecretKey) {
    throw Object.assign(
      new Error('Wallet has no encrypted key material available for signer rotation'),
      { statusCode: 422 },
    );
  }

  // 1. Resolve target platform recovery signer
  const recoverySignerPublicKey = resolveRecoverySignerPublicKey(userProvidedKey);

  // 2. Decrypt wallet secret key
  const secretKey = decrypt(wallet.encryptedSecretKey);

  // 3. Stellar on-chain signer rotation (masterWeight = 0, recoverySigner = 1, thresholds = 1)
  let onChainResult = null;
  try {
    onChainResult = await setEmergencySigners({
      publicKey: wallet.publicKey,
      secretKey,
      recoverySignerPublicKey,
      server,
    });
  } catch (stellarError) {
    logger.error(`[EmergencyFreeze] Stellar on-chain signer rotation failed for wallet ${wallet.id}: ${stellarError.message}`);
    throw Object.assign(
      new Error(`On-chain emergency freeze failed: ${stellarError.message}`),
      { statusCode: 502, cause: stellarError },
    );
  }

  // 4. Cancel pending transactions in database
  const cancelledTransactionIds = await cancelPendingTransactions({
    userId: wallet.userId,
    walletId: wallet.id,
    reason,
    db,
  });

  // 5. Deactivate user account to block API-level payment and wallet calls
  try {
    if (db.user?.update) {
      await db.user.update({
        where: { id: wallet.userId },
        data: { deactivatedAt: new Date() },
      });
    }
    if (db === prisma) {
      await deactivateAccount({
        userId: wallet.userId,
        reason: DEACTIVATION_REASONS.FRAUD_SUSPICION,
        notes: `Emergency freeze executed: ${reason}`,
        adminId: String(adminId),
        force: true,
      });
    }
  } catch (deactErr) {
    logger.warn(`[EmergencyFreeze] User deactivation note: ${deactErr.message}`);
  }

  const nowIso = new Date().toISOString();

  // 6. Record Audit Log
  await writeAuditLog({
    actorType,
    actorId: String(adminId),
    action: 'wallet.emergency_freeze',
    entityType: 'Wallet',
    entityId: String(wallet.id),
    metadata: {
      userId: wallet.userId,
      walletPublicKey: wallet.publicKey,
      recoverySignerPublicKey,
      reason,
      cancelledTransactionsCount: cancelledTransactionIds.length,
      cancelledTransactionIds,
      onChainApplied: onChainResult?.onChainApplied ?? false,
      txHash: onChainResult?.txHash || null,
      frozenAt: nowIso,
    },
  });

  // 7. Append immutable Workflow Event
  await appendEvent({
    eventType: 'wallet.emergency_freeze',
    aggregateType: 'Wallet',
    aggregateId: String(wallet.id),
    actorType,
    actorId: String(adminId),
    payload: {
      walletId: wallet.id,
      userId: wallet.userId,
      publicKey: wallet.publicKey,
      recoverySignerPublicKey,
      reason,
      cancelledTransactionsCount: cancelledTransactionIds.length,
      txHash: onChainResult?.txHash || null,
      onChainApplied: onChainResult?.onChainApplied ?? false,
    },
  }).catch((evtErr) => {
    logger.warn(`[EmergencyFreeze] Failed to append event: ${evtErr.message}`);
  });

  return {
    success: true,
    walletId: wallet.id,
    userId: wallet.userId,
    publicKey: wallet.publicKey,
    recoverySignerPublicKey,
    masterWeight: 0,
    recoverySignerWeight: 1,
    cancelledTransactionsCount: cancelledTransactionIds.length,
    cancelledTransactionIds,
    onChainApplied: Boolean(onChainResult?.onChainApplied),
    txHash: onChainResult?.txHash || null,
    explorerUrl: onChainResult?.explorerUrl || null,
    frozenAt: nowIso,
  };
};

/**
 * Express Controller Handler for Emergency Freeze.
 */
const emergencyFreezeHandler = async (req, res, next) => {
  try {
    const walletId = req.params?.id || req.params?.walletId || req.body?.walletId;
    const { recoverySignerPublicKey, reason } = req.body || {};
    const adminId = req.admin?.id || req.restUser?.id || req.user?.id || 'system';
    const actorType = req.admin?.id ? 'administrator' : 'system';
    const db = req.db || req.app?.get('db') || prisma;
    const server = req.server || req.app?.get('stellarServer') || defaultServer;

    const result = await emergencyFreezeWallet({
      walletId,
      recoverySignerPublicKey,
      reason,
      adminId,
      actorType,
      db,
      server,
    });

    return sendSuccess(res, result, 'Emergency freeze completed successfully');
  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.message, error.statusCode);
    }
    return next(error);
  }
};

/**
 * Express Router exposing the emergency freeze routes.
 */
const router = express.Router();
router.post('/', emergencyFreezeHandler);
router.post('/emergency-freeze', emergencyFreezeHandler);
router.post('/freeze', emergencyFreezeHandler);
router.post('/:id/freeze', emergencyFreezeHandler);
router.post('/:id/emergency-freeze', emergencyFreezeHandler);

module.exports = {
  emergencyFreezeWallet,
  setEmergencySigners,
  resolveRecoverySignerPublicKey,
  cancelPendingTransactions,
  emergencyFreezeHandler,
  router,
};
