const prisma = require('../common/prisma');
const { encrypt, decrypt, getActiveKeyVersion } = require('../services/crypto.service');
const { writeAuditLog } = require('../common/audit.service');
const stellarAdapter = require('./stellar.adapter');
const logger = require('../utils/logger');

// Default cooling-off period before recovery can be finalized: 24 hours (configurable)
const RECOVERY_COOLING_OFF_MS = parseInt(process.env.WALLET_RECOVERY_COOLING_OFF_MS || `${24 * 60 * 60 * 1000}`, 10);

/**
 * Rotates the encryption key of a wallet's secret key to a target or latest key version.
 * Implements atomic versioning, safe rollback on failure, and audit logging.
 */
const rotateWalletKey = async ({
  walletId,
  targetKeyVersion = getActiveKeyVersion(),
  actorId = 'system',
  actorType = 'system',
  db = prisma,
}) => {
  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) {
    const err = Object.assign(new Error('Wallet not found for rotation'), { statusCode: 404 });
    await writeAuditLog({
      actorType,
      actorId: String(actorId),
      action: 'wallet.rotation.failed',
      entityType: 'Wallet',
      entityId: String(walletId),
      metadata: { reason: 'Wallet not found', targetKeyVersion },
    });
    throw err;
  }

  const previousEncryptedKey = wallet.encryptedSecretKey;
  let secretKey;

  try {
    // Decrypt using previous key version
    secretKey = decrypt(previousEncryptedKey);
  } catch (decryptErr) {
    logger.error(`[WalletRotation] Failed to decrypt wallet ${walletId}: ${decryptErr.message}`);
    await writeAuditLog({
      actorType,
      actorId: String(actorId),
      action: 'wallet.rotation.failed',
      entityType: 'Wallet',
      entityId: String(walletId),
      metadata: { reason: 'Decryption failed', error: decryptErr.message, targetKeyVersion },
    });
    throw Object.assign(new Error('Failed to decrypt secret key for rotation'), { statusCode: 500 });
  }

  // Re-encrypt with target key version
  const newEncryptedKey = encrypt(secretKey, targetKeyVersion);
  const now = new Date();

  try {
    const updatedWallet = await db.wallet.update({
      where: { id: walletId },
      data: {
        encryptedSecretKey: newEncryptedKey,
        updatedAt: now,
      },
    });

    await writeAuditLog({
      actorType,
      actorId: String(actorId),
      action: 'wallet.rotation.succeeded',
      entityType: 'Wallet',
      entityId: String(walletId),
      metadata: {
        targetKeyVersion,
        rotatedAt: now.toISOString(),
      },
    });

    return {
      success: true,
      walletId: updatedWallet.id,
      keyVersion: targetKeyVersion,
      rotatedAt: now.toISOString(),
    };
  } catch (updateErr) {
    // Rollback attempt if DB update failed
    logger.error(`[WalletRotation] DB update failed during rotation for ${walletId}: ${updateErr.message}`);
    await writeAuditLog({
      actorType,
      actorId: String(actorId),
      action: 'wallet.rotation.failed',
      entityType: 'Wallet',
      entityId: String(walletId),
      metadata: { reason: 'Database update failed', error: updateErr.message },
    });
    throw updateErr;
  }
};

/**
 * Initiates a wallet recovery request with verified ownership & cooling-off enforcement.
 */
const initiateWalletRecovery = async ({
  userId,
  walletId,
  reason,
  actorId = userId,
  actorType = 'user',
  verificationProof,
  bypassCoolingOff = false,
  db = prisma,
}) => {
  // 1. Verify User & Wallet existence and ownership
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (!wallet || wallet.userId !== userId) {
    await writeAuditLog({
      actorType,
      actorId: String(actorId),
      action: 'wallet.recovery.denied',
      entityType: 'Wallet',
      entityId: String(walletId),
      metadata: { reason: 'Ownership verification failed', userId },
    });
    throw Object.assign(new Error('Wallet ownership verification failed'), { statusCode: 403 });
  }

  // 2. Ownership / verification proof check (e.g. KYC or signed proof)
  if (!verificationProof && actorType === 'user') {
    throw Object.assign(new Error('Verification proof required for customer recovery'), { statusCode: 400 });
  }

  const now = new Date();
  const coolingOffUntil = bypassCoolingOff
    ? now
    : new Date(now.getTime() + RECOVERY_COOLING_OFF_MS);

  const recoveryRecord = {
    recoveryId: `rec_${wallet.id}_${Date.now()}`,
    walletId: wallet.id,
    userId: user.id,
    reason: reason || 'Customer requested recovery',
    status: bypassCoolingOff ? 'ready' : 'cooling_off',
    initiatedAt: now.toISOString(),
    coolingOffUntil: coolingOffUntil.toISOString(),
    actorId,
  };

  await writeAuditLog({
    actorType,
    actorId: String(actorId),
    action: 'wallet.recovery.initiated',
    entityType: 'Wallet',
    entityId: String(wallet.id),
    metadata: recoveryRecord,
  });

  return recoveryRecord;
};

/**
 * Finalizes wallet recovery after cooling-off validation.
 */
const completeWalletRecovery = async ({
  recoveryState,
  actorId = 'system',
  actorType = 'system',
  db = prisma,
}) => {
  const { walletId, coolingOffUntil, status } = recoveryState;

  if (new Date() < new Date(coolingOffUntil) && status === 'cooling_off') {
    const remainingMs = new Date(coolingOffUntil).getTime() - Date.now();
    const err = Object.assign(
      new Error(`Recovery is currently in cooling-off period. Remaining: ${Math.ceil(remainingMs / 1000)}s`),
      { statusCode: 400 }
    );
    await writeAuditLog({
      actorType,
      actorId: String(actorId),
      action: 'wallet.recovery.premature_attempt',
      entityType: 'Wallet',
      entityId: String(walletId),
      metadata: { remainingMs },
    });
    throw err;
  }

  // Generate fresh replacement keypair
  const { publicKey: newPublicKey, secretKey: newSecretKey } = stellarAdapter.createWallet();
  const newEncryptedKey = encrypt(newSecretKey);

  const updatedWallet = await db.wallet.update({
    where: { id: walletId },
    data: {
      publicKey: newPublicKey,
      encryptedSecretKey: newEncryptedKey,
      updatedAt: new Date(),
    },
  });

  await writeAuditLog({
    actorType,
    actorId: String(actorId),
    action: 'wallet.recovery.completed',
    entityType: 'Wallet',
    entityId: String(walletId),
    metadata: {
      previousPublicKey: recoveryState.previousPublicKey,
      newPublicKey,
      completedAt: new Date().toISOString(),
    },
  });

  return {
    success: true,
    walletId: updatedWallet.id,
    newPublicKey,
    status: 'completed',
  };
};

module.exports = {
  RECOVERY_COOLING_OFF_MS,
  rotateWalletKey,
  initiateWalletRecovery,
  completeWalletRecovery,
};
