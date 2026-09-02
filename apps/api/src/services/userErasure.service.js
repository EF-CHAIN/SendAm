'use strict';

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

const anonymizeUser = async (db, options = {}) => {
  const {
    userId,
    actorId = 'system',
    actorType = 'system',
    reason = 'user-requested',
    jurisdiction = 'unknown',
    legalHold = false,
  } = options;

  if (!userId) {
    throw new Error('userId is required to anonymize a user.');
  }

  const safeDb = withErasureGuard(db);
  const user = await safeDb.user.findUnique({ where: { id: userId } });

  if (!user) {
    return { status: 'not_found', user: null };
  }

  const anonymizedPhone = `deleted-user-${userId}`;
  // eslint-disable-next-line no-unused-vars
  const anonymizedUser = {
    ...user,
    phoneNumber: anonymizedPhone,
    whatsappName: 'Deleted User',
    kycTier: 0,
    riskScore: 0,
    pinHash: null,
    pinSetAt: null,
    pendingSend: null,
    contactsJson: null,
    deletedAt: new Date(),
    deletionStatus: 'anonymized',
    anonymizedAt: new Date(),
    legalHold,
  };

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

  await safeDb.contact.updateMany({
    where: { ownerId: userId },
    data: {
      phoneNumber: `deleted-contact-${userId}`,
      displayName: 'Deleted User',
      defaultCurrency: 'USD',
      defaultAsset: 'USDC',
      updatedAt: new Date(),
    },
  });

  await safeDb.alias.updateMany({
    where: { userId },
    data: {
      alias: `deleted-alias-${userId}`,
      target: `deleted-target-${userId}`,
      updatedAt: new Date(),
    },
  });

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
      },
      updatedAt: new Date(),
    },
  });

  await safeDb.kycProfile.updateMany({
    where: { userId },
    data: {
      providerReference: null,
      country: null,
      metadata: {
        action: 'redacted-on-erasure',
        jurisdiction,
        legalHold,
      },
      updatedAt: new Date(),
    },
  });

  await safeDb.voiceCommand.updateMany({
    where: { userId },
    data: {
      phoneNumber: anonymizedPhone,
      transcript: null,
      audioUrl: null,
      whatsappMessageId: null,
      metadata: {
        action: 'redacted-on-erasure',
      },
      updatedAt: new Date(),
    },
  });

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

  const updatedUser = await safeDb.user.update({
    where: { id: userId },
    data: {
      phoneNumber: anonymizedPhone,
      whatsappName: 'Deleted User',
      kycTier: 0,
      riskScore: 0,
      pinHash: null,
      pinSetAt: null,
      pendingSend: null,
      contactsJson: null,
      deletedAt: new Date(),
      deletionStatus: 'anonymized',
      anonymizedAt: new Date(),
      legalHold,
      updatedAt: new Date(),
    },
  });

  const erasure = await safeDb.userErasure.create({
    data: {
      userId,
      actorType,
      actorId,
      reason,
      jurisdiction,
      legalHold,
      status: 'completed',
      executedAt: new Date(),
    },
  });

  return {
    status: 'anonymized',
    user: updatedUser,
    erasure,
    retentionMatrix: RETENTION_MATRIX,
  };
};

module.exports = {
  RETENTION_MATRIX,
  buildRetentionMatrix,
  withErasureGuard,
  anonymizeUser,
};
