const crypto = require('crypto');
const prisma = require('../common/prisma');
const { writeAuditLog } = require('../common/audit.service');
const retention = require('./retention');
const { ProviderSkippedError } = require('./providerErrors');
const smileId = require('./smileId.provider');
const whatsapp = require('../services/whatsapp.service');
const voice = require('../voice/voice.service');
const monitoring = require('./providers/monitoring');

// External providers an erasure must propagate to. Each has a best-effort
// adapter; failures are recorded as retryable tasks, never thrown to the user.
const PROVIDERS = ['smileid', 'whatsapp', 'voice', 'monitoring'];

// Strip secrets (never exported, never audited). Used for the export payload.
const stripSecrets = (record) => {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  for (const field of retention.SECRET_FIELDS) delete out[field];
  return out;
};

const hasActiveLegalHold = async (userId) => {
  const hold = await prisma.legalHold.findFirst({
    where: { userId, releasedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  });
  return Boolean(hold);
};

// ---------------------------------------------------------------------------
// Legal holds
// ---------------------------------------------------------------------------
const setLegalHold = async ({ userId, reason, heldBy, expiresAt = null, req } = {}) => {
  if (!userId) {
    const error = new Error('userId is required');
    error.statusCode = 400;
    throw error;
  }
  if (!reason || String(reason).trim().length < retention.LEGAL_HOLD_POLICY.minReasonLength) {
    const error = new Error('A legal hold requires a descriptive reason');
    error.statusCode = 400;
    throw error;
  }
  const hold = await prisma.legalHold.create({
    data: { userId, reason: String(reason).trim(), heldBy, expiresAt: expiresAt ? new Date(expiresAt) : null },
  });
  await writeAuditLog({
    actorType: 'administrator',
    actorId: heldBy,
    action: 'admin.legal_hold.set',
    entityType: 'LegalHold',
    entityId: hold.id,
    metadata: { expiresAt: hold.expiresAt ? hold.expiresAt.toISOString() : null },
    req,
  });
  return hold;
};

const releaseLegalHold = async ({ userId, releasedBy, req } = {}) => {
  const result = await prisma.legalHold.updateMany({
    where: { userId, releasedAt: null },
    data: { releasedAt: new Date() },
  });
  await writeAuditLog({
    actorType: 'administrator',
    actorId: releasedBy,
    action: 'admin.legal_hold.released',
    entityType: 'LegalHold',
    entityId: userId,
    metadata: { released: result.count },
    req,
  });
  return result;
};

const listLegalHolds = async (userId) => {
  const where = userId ? { userId, releasedAt: null } : { releasedAt: null };
  return prisma.legalHold.findMany({ where, orderBy: { createdAt: 'desc' } });
};

// ---------------------------------------------------------------------------
// Export (data portability) — customer is entitled to their own data
// ---------------------------------------------------------------------------
const collectExport = async (userId) => {
  const [
    user, wallets, transactions, kycProfile, voiceCommands,
    contacts, aliases, notifications, quotes, restSessions,
  ] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.wallet.findMany({ where: { userId } }),
    prisma.transaction.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
    prisma.kycProfile.findUnique({ where: { userId } }),
    prisma.voiceCommand.findMany({ where: { userId } }),
    prisma.contact.findMany({ where: { ownerId: userId } }),
    prisma.alias.findMany({ where: { userId } }),
    prisma.notification.findMany({ where: { userId } }),
    prisma.quote.findMany({ where: { userId } }),
    prisma.restSession.findMany({ where: { userId } }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    schema: 'sendam-privacy-export/v1',
    user: user ? stripSecrets(user) : null,
    wallets: wallets.map(stripSecrets),
    transactions: transactions.map(stripSecrets),
    kycProfile: kycProfile ? stripSecrets(kycProfile) : null,
    voiceCommands: voiceCommands.map(stripSecrets),
    contacts: contacts.map(stripSecrets),
    aliases: aliases.map(stripSecrets),
    notifications: notifications.map(stripSecrets),
    quotes: quotes.map(stripSecrets),
    restSessions: restSessions.map(stripSecrets),
  };
};

const requestDataExport = async (userId, { req } = {}) => {
  const data = await collectExport(userId);
  const request = await prisma.privacyRequest.create({
    data: {
      userId,
      type: 'export',
      status: 'completed',
      requestedBy: 'self',
      completedAt: new Date(),
      result: { models: Object.keys(data).filter((k) => k !== 'exportedAt' && k !== 'schema') },
    },
  });
  await writeAuditLog({
    actorType: 'customer',
    actorId: userId,
    action: 'privacy.export.completed',
    entityType: 'PrivacyRequest',
    entityId: request.id,
    metadata: { type: 'export' },
    req,
  });
  return { request, data };
};

// ---------------------------------------------------------------------------
// Erasure request lifecycle
// ---------------------------------------------------------------------------
const requestErasure = async (userId, { reason, requestedBy = 'self', req } = {}) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }
  const kycProfile = await prisma.kycProfile.findUnique({ where: { userId } });
  const request = await prisma.privacyRequest.create({
    data: {
      userId,
      type: 'erasure',
      status: 'pending',
      reason: reason ? String(reason) : null,
      requestedBy,
    },
  });
  // Snapshot the identifiers needed for provider propagation BEFORE we wipe
  // them locally, so retries can still target the right remote records.
  await prisma.privacyRequest.update({
    where: { id: request.id },
    data: {
      result: {
        snapshot: {
          phoneNumber: user.phoneNumber,
          kycProviderReference: kycProfile?.providerReference || null,
        },
      },
    },
  });
  await writeAuditLog({
    actorType: requestedBy === 'self' ? 'customer' : 'administrator',
    actorId: userId,
    action: 'privacy.erasure.requested',
    entityType: 'PrivacyRequest',
    entityId: request.id,
    metadata: { type: 'erasure' },
    req,
  });
  return request;
};

// Anonymize local records in a single transaction. Ledger/audit rows survive;
// only identity PII and secrets are cleared per the retention matrix.
const anonymizeLocal = async (userId) => {
  const anonymizedPhone = `anonymized:${crypto.randomBytes(8).toString('hex')}`;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { phoneNumber: anonymizedPhone, whatsappName: null, pinHash: null, anonymizedAt: new Date() },
    });
    await tx.wallet.updateMany({ where: { userId }, data: retention.ANONYMIZATION_FIELDS.Wallet });
    const kyc = await tx.kycProfile.findUnique({ where: { userId } });
    if (kyc) {
      const metadata = {
        ...(retention.ANONYMIZATION_FIELDS.KycProfile.metadata || {}),
        erasedAt: new Date().toISOString(),
        reason: 'gdpr_ndpa_erasure',
      };
      await tx.kycProfile.update({
        where: { id: kyc.id },
        data: { country: null, metadata, status: 'erased' },
      });
    }
    await tx.voiceCommand.updateMany({ where: { userId }, data: retention.ANONYMIZATION_FIELDS.VoiceCommand });
    await tx.contact.updateMany({ where: { ownerId: userId }, data: retention.ANONYMIZATION_FIELDS.Contact });
    await tx.alias.deleteMany({ where: { userId } });
    await tx.notification.updateMany({ where: { userId }, data: retention.ANONYMIZATION_FIELDS.Notification });
    await tx.quote.updateMany({ where: { userId }, data: retention.ANONYMIZATION_FIELDS.Quote });
    await tx.restSession.updateMany({ where: { userId }, data: retention.ANONYMIZATION_FIELDS.RestSession });
    // Counterparty PII on the user's own ledger entries is redacted; the
    // financial amounts/hashes that AML requires are retained.
    await tx.transaction.updateMany({ where: { userId }, data: { recipientPhoneNumber: null, destination: null } });
  });
};

const runProviderTask = async (taskId, provider, target) => {
  const task = await prisma.privacyProviderTask.findUnique({ where: { id: taskId } });
  if (!task || task.status === 'success' || task.status === 'skipped') return;

  try {
    let result;
    switch (provider) {
      case 'smileid': result = await smileId.deleteSubject({ userId: target.id, providerReference: target.kycProviderReference }); break;
      case 'whatsapp': result = await whatsapp.deleteUserData(target.phoneNumber); break;
      case 'voice': result = await voice.deleteUserData(target.id); break;
      case 'monitoring': result = await monitoring.deleteUserData(target); break;
      default: throw new Error(`Unknown provider ${provider}`);
    }
    const status = result && result.skipped ? 'skipped' : 'success';
    await prisma.privacyProviderTask.update({
      where: { id: taskId },
      data: { status, attempts: task.attempts + 1, lastError: null, startedAt: task.startedAt || new Date(), completedAt: new Date() },
    });
  } catch (error) {
    const skipped = error.skipped === true || error.name === 'ProviderSkippedError';
    await prisma.privacyProviderTask.update({
      where: { id: taskId },
      data: {
        status: skipped ? 'skipped' : 'failed',
        attempts: task.attempts + 1,
        lastError: String(error.message || 'unknown').slice(0, 500),
        startedAt: task.startedAt || new Date(),
        completedAt: skipped ? new Date() : null,
      },
    });
  }
};

const runProviderPropagation = async (requestId, target) => {
  for (const provider of PROVIDERS) {
    const task = await prisma.privacyProviderTask.create({
      data: { privacyRequestId: requestId, provider, status: 'pending' },
    });
    await runProviderTask(task.id, provider, target);
  }
};

const buildTarget = (request) => {
  const snapshot = request?.result?.snapshot || {};
  return {
    id: request.userId,
    phoneNumber: snapshot.phoneNumber || null,
    kycProviderReference: snapshot.kycProviderReference || null,
  };
};

// Idempotent: a second call on an already-anonymized user does not re-run local
// anonymization but still allows retrying failed provider tasks.
const fulfillErasure = async (userId, { requestId, approvedBy } = {}) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }
  const request = requestId ? await prisma.privacyRequest.findUnique({ where: { id: requestId } }) : null;
  const target = request
    ? buildTarget(request)
    : { id: userId, phoneNumber: user.phoneNumber || null, kycProviderReference: null };

  if (user.anonymizedAt) {
    if (requestId) await runProviderPropagation(requestId, target);
    return { anonymized: false, alreadyAnonymized: true };
  }
  if (await hasActiveLegalHold(userId)) {
    const error = new Error('Erasure is blocked by an active legal hold');
    error.statusCode = 409;
    throw error;
  }
  await anonymizeLocal(userId);
  if (requestId) await runProviderPropagation(requestId, target);
  return { anonymized: true, alreadyAnonymized: false };
};

const approveRequest = async ({ id, approvedBy, decision = 'approve', req } = {}) => {
  const request = await prisma.privacyRequest.findUnique({ where: { id } });
  if (!request) {
    const error = new Error('Privacy request not found');
    error.statusCode = 404;
    throw error;
  }
  if (request.status !== 'pending') {
    const error = new Error('Privacy request has already been processed');
    error.statusCode = 409;
    throw error;
  }
  if (decision === 'deny') {
    await prisma.privacyRequest.update({ where: { id }, data: { status: 'denied', approvedBy, approvedAt: new Date() } });
    await writeAuditLog({
      actorType: 'administrator', actorId: approvedBy, action: 'privacy.erasure.denied',
      entityType: 'PrivacyRequest', entityId: id, metadata: { type: request.type }, req,
    });
    return request;
  }
  if (request.type !== 'erasure') {
    const error = new Error('Only erasure requests require approval');
    error.statusCode = 400;
    throw error;
  }

  await prisma.privacyRequest.update({ where: { id }, data: { status: 'in_progress', approvedBy, approvedAt: new Date() } });
  try {
    const summary = await fulfillErasure(request.userId, { requestId: id, approvedBy });
    const tasks = await prisma.privacyProviderTask.findMany({
      where: { privacyRequestId: id },
      select: { provider: true, status: true },
    });
    await prisma.privacyRequest.update({
      where: { id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        result: { anonymized: summary.anonymized, alreadyAnonymized: summary.alreadyAnonymized, providers: tasks },
      },
    });
    await writeAuditLog({
      actorType: 'administrator', actorId: approvedBy, action: 'privacy.erasure.completed',
      entityType: 'PrivacyRequest', entityId: id, metadata: { type: 'erasure' }, req,
    });
    return request;
  } catch (error) {
    await prisma.privacyRequest.update({
      where: { id },
      data: { status: 'failed', result: { error: String(error.message || 'unknown').slice(0, 200) } },
    });
    await writeAuditLog({
      actorType: 'administrator', actorId: approvedBy, action: 'privacy.erasure.failed',
      entityType: 'PrivacyRequest', entityId: id,
      metadata: { type: 'erasure', error: String(error.message || 'unknown').slice(0, 200) }, req,
    });
    const wrapped = new Error(error.message || 'Erasure failed');
    wrapped.statusCode = error.statusCode || 500;
    throw wrapped;
  }
};

const retryProviders = async ({ id, req } = {}) => {
  const request = await prisma.privacyRequest.findUnique({ where: { id } });
  if (!request) {
    const error = new Error('Privacy request not found');
    error.statusCode = 404;
    throw error;
  }
  const failed = await prisma.privacyProviderTask.findMany({ where: { privacyRequestId: id, status: 'failed' } });
  const target = buildTarget(request);
  for (const task of failed) {
    await runProviderTask(task.id, task.provider, target);
  }
  await writeAuditLog({
    actorType: 'administrator', actorId: req?.admin?.id, action: 'privacy.providers.retried',
    entityType: 'PrivacyRequest', entityId: id, metadata: { retried: failed.length }, req,
  });
  return { retried: failed.length };
};

// ---------------------------------------------------------------------------
// Admin read access
// ---------------------------------------------------------------------------
const listRequests = async ({ type, status } = {}) => {
  const where = {};
  if (type) where.type = type;
  if (status) where.status = status;
  return prisma.privacyRequest.findMany({ where, orderBy: { createdAt: 'desc' } });
};

const getRequest = async (id) => {
  const request = await prisma.privacyRequest.findUnique({
    where: { id },
    include: { tasks: { orderBy: { createdAt: 'asc' } } },
  });
  if (!request) {
    const error = new Error('Privacy request not found');
    error.statusCode = 404;
    throw error;
  }
  return request;
};

module.exports = {
  PROVIDERS,
  hasActiveLegalHold,
  setLegalHold,
  releaseLegalHold,
  listLegalHolds,
  requestDataExport,
  requestErasure,
  approveRequest,
  retryProviders,
  fulfillErasure,
  listRequests,
  getRequest,
};
