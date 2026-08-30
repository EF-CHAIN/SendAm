'use strict';

const { decrypt, encrypt, registerKeyVersion, CURRENT_VERSION } = require('../src/services/crypto.service');
const logger = require('../src/utils/logger');

/**
 * Resumable production wallet key rotation tool (#148).
 *
 * Re-encrypts wallet secret keys under a new key version and updates keyVersion metadata.
 * Redacts secret keys and plaintext data from all logs, metrics, and error reports.
 */
const rotateWalletKeys = async ({
  prisma,
  targetVersion = CURRENT_VERSION,
  newKeyHex = null,
  batchSize = 100,
  dryRun = false,
} = {}) => {
  const startTime = Date.now();

  if (newKeyHex) {
    registerKeyVersion(targetVersion, newKeyHex);
  }

  const report = {
    targetVersion,
    batchSize,
    dryRun,
    scannedCount: 0,
    rotatedCount: 0,
    alreadyCurrentCount: 0,
    failedCount: 0,
    durationMs: 0,
    errors: [],
  };

  const wallets = await prisma.wallet.findMany({
    where: {
      encryptedSecretKey: { not: null },
    },
    select: {
      id: { select: false }, // avoid logging sensitive identifiers unnecessarily
      id: true,
      publicKey: true,
      encryptedSecretKey: true,
      keyVersion: true,
    },
  });

  report.scannedCount = wallets.length;

  const toRotate = wallets.filter((w) => {
    if (w.keyVersion !== targetVersion) return true;
    const parts = (w.encryptedSecretKey || '').split(':');
    return parts[0] !== targetVersion;
  });

  report.alreadyCurrentCount = wallets.length - toRotate.length;

  if (dryRun) {
    report.rotatedCount = toRotate.length;
    report.durationMs = Date.now() - startTime;
    return report;
  }

  // Process in batches
  for (let i = 0; i < toRotate.length; i += batchSize) {
    const batch = toRotate.slice(i, i + batchSize);

    for (const wallet of batch) {
      try {
        const plaintextSecret = decrypt(wallet.encryptedSecretKey);
        const newCiphertext = encrypt(plaintextSecret, targetVersion);

        await prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            encryptedSecretKey: newCiphertext,
            keyVersion: targetVersion,
          },
        });

        report.rotatedCount += 1;
      } catch (err) {
        report.failedCount += 1;
        // Redact secret key material from logs and error summaries
        const safeErrMsg = err.message ? err.message.replace(/S[A-Z0-9]{55}/g, '[REDACTED_SECRET]') : 'Unknown rotation error';
        report.errors.push({
          walletId: wallet.id,
          publicKey: wallet.publicKey,
          error: safeErrMsg,
        });
        logger.error(`Key rotation error for wallet ${wallet.publicKey}: ${safeErrMsg}`);
      }
    }
  }

  report.durationMs = Date.now() - startTime;
  return report;
};

const run = async () => {
  const prisma = require('../src/common/prisma');
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  let targetVersion = CURRENT_VERSION;
  const targetVerArg = args.find((a) => a.startsWith('--target-version='));
  if (targetVerArg) targetVersion = targetVerArg.split('=')[1];

  let batchSize = 100;
  const batchArg = args.find((a) => a.startsWith('--batch-size='));
  if (batchArg) batchSize = Number(batchArg.split('=')[1]) || 100;

  let newKeyHex = null;
  const keyArg = args.find((a) => a.startsWith('--new-key='));
  if (keyArg) newKeyHex = keyArg.split('=')[1];

  try {
    const report = await rotateWalletKeys({
      prisma,
      targetVersion,
      newKeyHex,
      batchSize,
      dryRun,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.failedCount > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Wallet key rotation failed:', err.message);
    process.exitCode = 1;
  }
};

if (require.main === module) run();

module.exports = {
  rotateWalletKeys,
};
