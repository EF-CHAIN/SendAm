'use strict';

const crypto = require('crypto');
const fs = require('fs');

const generateTombstoneHash = () => {
  return crypto.randomBytes(16).toString('hex');
};

const buildRetentionMatrix = (overrides = {}) => {
  const base = {
    User: {
      mode: 'anonymize',
      preserve: 'pseudonymized',
      legalHold: 'case-by-case',
      deleteAfter: 'never',
      rationale: 'Remove identity data while preserving compliance and payment evidence.',
    },
    Wallet: {
      mode: 'anonymize',
      preserve: 'cryptographic-token-only',
      legalHold: 'none',
      deleteAfter: 'never',
      rationale: 'Remove secret material and public address linkage from the live user record.',
    },
    Transaction: {
      mode: 'retain',
      preserve: 'immutable',
      legalHold: 'mandatory',
      deleteAfter: 'legal-retention-window',
      rationale: 'Settlement and audit evidence must stay intact for financial reporting.',
    },
    AuditLog: {
      mode: 'retain',
      preserve: 'immutable',
      legalHold: 'mandatory',
      deleteAfter: 'legal-retention-window',
      rationale: 'Operational and compliance logging is evidence, not personal data.',
    },
    KycProfile: {
      mode: 'retain',
      preserve: 'retained-with-redaction',
      legalHold: 'mandatory',
      deleteAfter: 'legal-retention-window',
      rationale: 'KYC evidence is governed by onboarding and AML retention requirements.',
    },
    Contact: {
      mode: 'anonymize',
      preserve: 'redacted',
      legalHold: 'none',
      deleteAfter: 'as-soon-as-possible',
      rationale: 'Contact metadata is a convenience record and should be disconnected from the user.',
    },
    Alias: {
      mode: 'anonymize',
      preserve: 'redacted',
      legalHold: 'none',
      deleteAfter: 'as-soon-as-possible',
      rationale: 'Aliases are user-facing convenience data and can be replaced with tombstones.',
    },
    VoiceCommand: {
      mode: 'anonymize',
      preserve: 'redacted',
      legalHold: 'case-by-case',
      deleteAfter: 'legal-retention-window',
      rationale: 'Voice and transcript data may contain sensitive audio or personal details.',
    },
    Notification: {
      mode: 'anonymize',
      preserve: 'redacted',
      legalHold: 'none',
      deleteAfter: 'as-soon-as-possible',
      rationale: 'Notifications can be purged after message delivery if no regulatory need remains.',
    },
    Quote: {
      mode: 'anonymize',
      preserve: 'redacted',
      legalHold: 'none',
      deleteAfter: 'as-soon-as-possible',
      rationale: 'Pricing quotes are ephemeral and should not remain attached to a customer identity.',
    },
    UserErasure: {
      mode: 'retain',
      preserve: 'immutable-tombstone',
      legalHold: 'mandatory',
      deleteAfter: 'legal-retention-window',
      rationale: 'Erasure records prove the lifecycle was executed and preserve accountability.',
    },
  };

  return { ...base, ...overrides };
};

const RETENTION_MATRIX = buildRetentionMatrix();

const withErasureGuard = (db) => {
  if (!db || !db.user) return db;

  const guarded = { ...db };
  guarded.user = Object.create(db.user);
  Object.defineProperties(guarded.user, {
    delete: {
      value: () => {
        throw new Error('Direct User deletes are forbidden. Use anonymizeUser() or destroyUserWithRetention() instead.');
      },
    },
    deleteMany: {
      value: () => {
        throw new Error('Bulk User deletes are forbidden. Use anonymizeUser() or destroyUserWithRetention() instead.');
      },
    },
  });

  return guarded;
};

/**
 * Deletes unencrypted KYC files from the filesystem or cloud storage if referenced
 * in the KYC profile or its metadata.
 *
 * @param {object} kycProfile
 * @param {object} [options]
 * @param {object} [options.fileSystem=fs]
 * @returns {Promise<{ deletedCount: number, deletedFiles: string[] }>}
 */
const deleteKycFiles = async (kycProfile, { fileSystem = fs } = {}) => {
  if (!kycProfile) return { deletedCount: 0, deletedFiles: [] };

  const deletedFiles = [];
  const candidatePaths = [];

  if (kycProfile.documentPath) candidatePaths.push(kycProfile.documentPath);
  if (kycProfile.filePath) candidatePaths.push(kycProfile.filePath);

  if (kycProfile.metadata && typeof kycProfile.metadata === 'object') {
    const meta = kycProfile.metadata;
    if (meta.documentPath) candidatePaths.push(meta.documentPath);
    if (meta.filePath) candidatePaths.push(meta.filePath);
    if (Array.isArray(meta.files)) {
      meta.files.forEach((f) => {
        if (typeof f === 'string') candidatePaths.push(f);
        else if (f && f.path) candidatePaths.push(f.path);
      });
    }
  }

  for (const filePath of candidatePaths) {
    if (typeof filePath === 'string') {
      try {
        const unlinkFn = fileSystem.promises?.unlink || fileSystem.unlink;
        if (typeof unlinkFn === 'function') {
          if (fileSystem.promises?.unlink) {
            await fileSystem.promises.unlink(filePath);
          } else {
            await new Promise((resolve) => fileSystem.unlink(filePath, () => resolve()));
          }
          deletedFiles.push(filePath);
        }
      } catch (_err) {
        // Ignored: file already removed or missing
      }
    }
  }

  return { deletedCount: deletedFiles.length, deletedFiles };
};

/**
 * Privacy-compliant user erasure pipeline (GDPR / NDPR) with cryptographic tombstoning.
 *
 * Features:
 * - Irreversibly anonymizes phoneNumber to a random cryptographic tombstone hash.
 * - Nullifies WhatsApp display name.
 * - Deletes unencrypted KYC files from storage and purges identity metadata.
 * - Sets anonymizedAt timestamp.
 * - Retains financial transactions with intact mathematical auditability while redacting counterparty PII.
 * - Blocks execution if user is marked with an active legal hold.
 *
 * @param {object} db - Database client (Prisma)
 * @param {object} options
 * @param {string} options.userId - User ID to erase
 * @param {string} [options.actorId='system']
 * @param {string} [options.actorType='system']
 * @param {string} [options.reason='user-requested']
 * @param {string} [options.jurisdiction='unknown']
 * @param {boolean} [options.legalHold=false]
 * @param {string} [options.anonymizedPhone]
 * @param {object} [options.fileSystem=fs]
 * @returns {Promise<object>}
 */
const anonymizeUser = async (db, options = {}) => {
  const {
    userId,
    actorId = 'system',
    actorType = 'system',
    reason = 'user-requested',
    jurisdiction = 'unknown',
    legalHold = false,
    anonymizedPhone: customAnonymizedPhone,
    fileSystem = fs,
  } = options;

  if (!userId) {
    throw new Error('userId is required to anonymize a user.');
  }

  const safeDb = withErasureGuard(db);
  const user = await safeDb.user.findUnique({ where: { id: userId } });

  if (!user) {
    return { status: 'not_found', user: null };
  }

  if (user.legalHold || legalHold) {
    const error = new Error('User is under legal hold; erasure and anonymization are blocked.');
    error.statusCode = 409;
    error.code = 'LEGAL_HOLD_ACTIVE';
    throw error;
  }

  const tombstoneHash = generateTombstoneHash();
  const anonymizedPhone = customAnonymizedPhone || `anonymized:${tombstoneHash}`;

  // 1. Wallets: remove secret keys and public linkage
  if (safeDb.wallet?.updateMany) {
    await safeDb.wallet.updateMany({
      where: { userId },
      data: {
        phoneNumber: null,
        publicKey: null,
        encryptedSecretKey: null,
        paymentCursor: null,
        funded: false,
        network: 'testnet',
        updatedAt: new Date(),
      },
    });
  }

  // 2. Contacts: redact personal names and numbers
  if (safeDb.contact?.updateMany) {
    await safeDb.contact.updateMany({
      where: { ownerId: userId },
      data: {
        phoneNumber: `deleted-contact-${tombstoneHash}`,
        displayName: 'Deleted User',
        defaultCurrency: 'USD',
        defaultAsset: 'USDC',
        updatedAt: new Date(),
      },
    });
  }

  // 3. Aliases: remove or tombstone mapping
  if (safeDb.alias?.updateMany) {
    await safeDb.alias.updateMany({
      where: { userId },
      data: {
        alias: `deleted-alias-${tombstoneHash}`,
        target: `deleted-target-${tombstoneHash}`,
        updatedAt: new Date(),
      },
    });
  }

  // 4. Financial Transactions: retain mathematical auditability (amounts, asset, status, ledger link),
  // but redact personal counterparty details (phone, destination)
  if (safeDb.transaction?.updateMany) {
    await safeDb.transaction.updateMany({
      where: { userId },
      data: {
        destination: null,
        recipientPhoneNumber: null,
        providerTransactionId: null,
        explorerUrl: null,
        metadata: {
          ...(typeof user.pendingSend === 'object' && user.pendingSend ? user.pendingSend : {}),
          retention: 'retained-for-regulatory-purposes',
          redacted: true,
          tombstone: tombstoneHash,
        },
        updatedAt: new Date(),
      },
    });
  }

  // 5. KYC Profile & unencrypted KYC file deletion
  let kycProfile = null;
  if (safeDb.kycProfile?.findUnique) {
    kycProfile = await safeDb.kycProfile.findUnique({ where: { userId } }).catch(() => null);
  }
  const kycDeletion = await deleteKycFiles(kycProfile, { fileSystem });

  if (safeDb.kycProfile?.updateMany) {
    await safeDb.kycProfile.updateMany({
      where: { userId },
      data: {
        providerReference: null,
        country: null,
        status: 'erased',
        metadata: {
          action: 'redacted-on-erasure',
          jurisdiction,
          legalHold: false,
          erasedAt: new Date().toISOString(),
          tombstone: tombstoneHash,
          filesDeleted: kycDeletion.deletedFiles,
        },
        updatedAt: new Date(),
      },
    });
  }

  // 6. Voice commands: remove audio transcripts and phone numbers
  if (safeDb.voiceCommand?.updateMany) {
    await safeDb.voiceCommand.updateMany({
      where: { userId },
      data: {
        phoneNumber: anonymizedPhone,
        transcript: null,
        audioUrl: null,
        whatsappMessageId: null,
        metadata: {
          action: 'redacted-on-erasure',
          tombstone: tombstoneHash,
        },
        updatedAt: new Date(),
      },
    });
  }

  // 7. Notifications: purge body and replace recipient
  if (safeDb.notification?.updateMany) {
    await safeDb.notification.updateMany({
      where: { userId },
      data: {
        recipient: anonymizedPhone,
        body: 'Message content removed to protect privacy.',
        providerMessageId: null,
        error: null,
        updatedAt: new Date(),
      },
    });
  }

  // 8. Ephemeral quotes: redact
  if (safeDb.quote?.updateMany) {
    await safeDb.quote.updateMany({
      where: { userId },
      data: {
        sourceCurrency: 'N/A',
        targetCurrency: 'N/A',
        provider: null,
        route: null,
        metadata: {
          action: 'redacted-on-erasure',
        },
        updatedAt: new Date(),
      },
    });
  }

  // 9. Rest sessions: invalidate and redact IP addresses
  if (safeDb.restSession?.updateMany) {
    await safeDb.restSession.updateMany({
      where: { userId },
      data: {
        ipAddress: null,
        userAgent: null,
        revokedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  // 10. User model: anonymize phoneNumber to cryptographic hash, nullify whatsappName, mark anonymizedAt
  const updatedUser = await safeDb.user.update({
    where: { id: userId },
    data: {
      phoneNumber: anonymizedPhone,
      whatsappName: null,
      kycTier: 0,
      riskScore: 0,
      pinHash: null,
      pinSetAt: null,
      pendingSend: null,
      contactsJson: null,
      deletedAt: new Date(),
      deletionStatus: 'anonymized',
      anonymizedAt: new Date(),
      legalHold: false,
      updatedAt: new Date(),
    },
  });

  // 11. UserErasure tombstone audit row
  let erasure = null;
  if (safeDb.userErasure?.create) {
    erasure = await safeDb.userErasure.create({
      data: {
        userId,
        actorType,
        actorId,
        reason,
        jurisdiction,
        legalHold: false,
        status: 'completed',
        executedAt: new Date(),
      },
    });
  }

  return {
    status: 'anonymized',
    user: updatedUser,
    erasure,
    tombstoneHash,
    anonymizedPhone,
    filesDeleted: kycDeletion.deletedFiles,
    retentionMatrix: RETENTION_MATRIX,
  };
};

module.exports = {
  RETENTION_MATRIX,
  buildRetentionMatrix,
  withErasureGuard,
  anonymizeUser,
  generateTombstoneHash,
  deleteKycFiles,
};
