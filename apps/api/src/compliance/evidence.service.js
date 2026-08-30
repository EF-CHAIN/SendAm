'use strict';

/**
 * Compliance Evidence Export Service (#329)
 * ───────────────────────────────────────────
 * Defines evidence objects and exportable content for regulatory and
 * internal review. Exports structured compliance evidence packages that
 * combine KYC records, transaction history, audit log entries, and event
 * ledger entries for a specific user or time window.
 *
 * Access control: all export functions are called only from admin routes
 * protected by `requireAdmin('compliance.read')`. The actingAdminId is
 * always written to the audit log so exports are fully traceable.
 *
 * Export formats:
 *   - JSON: full structured evidence (for programmatic review)
 *   - CSV:  flat representation (for spreadsheet review)
 *
 * Evidence objects:
 *   - ComplianceEvidencePackage: all compliance artefacts for one user
 *   - AuditExport:               filtered audit log records
 *   - EventExport:               filtered workflow event records
 *   - KycEvidenceExport:         KYC profile + screening results
 */

const prisma = require('../common/prisma');
const { writeAuditLog } = require('../common/audit.service');
const logger = require('../utils/logger');

const MAX_EXPORT_ROWS = 5000;

// ── CSV helpers ─────────────────────────────────────────────────────────

const escapeCsv = (value) => {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const toCsv = (rows, columns) => {
  const header = columns.map((c) => escapeCsv(c.header)).join(',');
  const body = rows
    .map((row) =>
      columns.map((c) => escapeCsv(typeof c.accessor === 'function' ? c.accessor(row) : row[c.accessor])).join(','),
    )
    .join('\n');
  return `${header}\n${body}\n`;
};

const isoDate = (val) => (val ? new Date(val).toISOString() : '');

// ── Evidence package builder ─────────────────────────────────────────────

/**
 * Build a full compliance evidence package for a single user.
 * Includes: user profile, KYC profile + screening results, transactions
 * (last 200), account status history, relevant audit log entries, and
 * workflow events.
 *
 * @param {string} userId           — Target user ID.
 * @param {string} actingAdminId    — Exporting admin ID (for audit log).
 * @param {object} [req]            — Express request (for audit log IP/UA).
 * @returns {Promise<object>}       — Structured evidence package.
 */
const buildUserEvidencePackage = async ({ userId, actingAdminId, req }) => {
  const [user, kyc, transactions, accountHistory, auditEntries, events] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phoneNumber: true,
        whatsappName: true,
        kycTier: true,
        riskScore: true,
        locale: true,
        messagingConsent: true,
        createdAt: true,
        updatedAt: true,
        deactivatedAt: true,
        deactivationReason: true,
        anonymizedAt: true,
      },
    }),
    prisma.kycProfile.findUnique({
      where: { userId },
      include: { screeningResults: { orderBy: { screenedAt: 'desc' }, take: 50 } },
    }),
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        type: true,
        amount: true,
        asset: true,
        fiatCurrency: true,
        fiatAmount: true,
        rail: true,
        routeType: true,
        destination: true,
        recipientPhoneNumber: true,
        txHash: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.accountStatusRecord.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.findMany({
      where: { OR: [{ entityId: userId }, { actorId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    prisma.workflowEvent.findMany({
      where: { aggregateType: 'User', aggregateId: userId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
  ]);

  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  await writeAuditLog({
    actorType: 'administrator',
    actorId: actingAdminId,
    action: 'admin.compliance.evidence.exported',
    entityType: 'User',
    entityId: userId,
    metadata: {
      exportType: 'user_evidence_package',
      transactionCount: transactions.length,
      auditEntryCount: auditEntries.length,
      eventCount: events.length,
    },
    req,
  }).catch((err) => logger.error('Audit log failed for evidence export', err.message));

  return {
    exportedAt: new Date().toISOString(),
    exportedBy: actingAdminId,
    subject: { userId, phoneNumber: user.phoneNumber },
    user,
    kyc: kyc || null,
    transactions,
    accountStatusHistory: accountHistory,
    auditLog: auditEntries,
    workflowEvents: events,
  };
};

// ── Workflow events export ───────────────────────────────────────────────

/**
 * Export workflow events as CSV for compliance review.
 *
 * @param {object}  filters
 * @param {string} [filters.eventType]
 * @param {string} [filters.aggregateType]
 * @param {string} [filters.aggregateId]
 * @param {string} [filters.from]
 * @param {string} [filters.to]
 * @param {string}  actingAdminId
 * @param {object} [req]
 */
const exportWorkflowEventsCsv = async ({ filters = {}, actingAdminId, req }) => {
  const where = {};
  if (filters.eventType)     where.eventType     = filters.eventType;
  if (filters.aggregateType) where.aggregateType = filters.aggregateType;
  if (filters.aggregateId)   where.aggregateId   = filters.aggregateId;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to)   where.createdAt.lte = new Date(filters.to);
  }

  const events = await prisma.workflowEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: MAX_EXPORT_ROWS,
  });

  await writeAuditLog({
    actorType: 'administrator',
    actorId: actingAdminId,
    action: 'admin.compliance.events.exported',
    entityType: 'WorkflowEvent',
    metadata: { filters, rows: events.length, capped: events.length >= MAX_EXPORT_ROWS },
    req,
  }).catch((err) => logger.error('Audit log failed for events export', err.message));

  return toCsv(events, [
    { header: 'id',            accessor: 'id' },
    { header: 'eventType',     accessor: 'eventType' },
    { header: 'aggregateType', accessor: 'aggregateType' },
    { header: 'aggregateId',   accessor: 'aggregateId' },
    { header: 'actorType',     accessor: 'actorType' },
    { header: 'actorId',       accessor: 'actorId' },
    { header: 'payload',       accessor: (r) => JSON.stringify(r.payload) },
    { header: 'createdAt',     accessor: (r) => isoDate(r.createdAt) },
  ]);
};

/**
 * Export KYC profiles with screening results as CSV.
 */
const exportKycEvidenceCsv = async ({ filters = {}, actingAdminId, req }) => {
  const where = {};
  if (filters.status)  where.status  = filters.status;
  if (filters.country) where.country = filters.country;
  if (filters.from || filters.to) {
    where.updatedAt = {};
    if (filters.from) where.updatedAt.gte = new Date(filters.from);
    if (filters.to)   where.updatedAt.lte = new Date(filters.to);
  }

  const profiles = await prisma.kycProfile.findMany({
    where,
    include: {
      user: { select: { phoneNumber: true, whatsappName: true } },
      screeningResults: { orderBy: { screenedAt: 'desc' }, take: 1 },
    },
    orderBy: { updatedAt: 'desc' },
    take: MAX_EXPORT_ROWS,
  });

  await writeAuditLog({
    actorType: 'administrator',
    actorId: actingAdminId,
    action: 'admin.compliance.kyc_evidence.exported',
    entityType: 'KycProfile',
    metadata: { filters, rows: profiles.length, capped: profiles.length >= MAX_EXPORT_ROWS },
    req,
  }).catch((err) => logger.error('Audit log failed for KYC evidence export', err.message));

  return toCsv(
    profiles.map((p) => ({
      ...p,
      phoneNumber: p.user?.phoneNumber,
      whatsappName: p.user?.whatsappName,
      latestScreeningStatus: p.screeningResults?.[0]?.status || '',
      latestScreeningProvider: p.screeningResults?.[0]?.provider || '',
      latestScreenedAt: p.screeningResults?.[0]?.screenedAt || null,
    })),
    [
      { header: 'id',                    accessor: 'id' },
      { header: 'phoneNumber',           accessor: 'phoneNumber' },
      { header: 'provider',              accessor: 'provider' },
      { header: 'tier',                  accessor: 'tier' },
      { header: 'status',                accessor: 'status' },
      { header: 'country',               accessor: 'country' },
      { header: 'riskScore',             accessor: 'riskScore' },
      { header: 'sanctionsStatus',       accessor: 'sanctionsStatus' },
      { header: 'custodyStatus',         accessor: 'custodyStatus' },
      { header: 'latestScreeningStatus', accessor: 'latestScreeningStatus' },
      { header: 'latestScreeningProvider', accessor: 'latestScreeningProvider' },
      { header: 'latestScreenedAt',      accessor: (r) => isoDate(r.latestScreenedAt) },
      { header: 'updatedAt',             accessor: (r) => isoDate(r.updatedAt) },
      { header: 'createdAt',             accessor: (r) => isoDate(r.createdAt) },
    ],
  );
};

/**
 * Export account deactivation/reactivation history as CSV.
 */
const exportAccountStatusHistoryCsv = async ({ filters = {}, actingAdminId, req }) => {
  const where = {};
  if (filters.userId) where.userId = filters.userId;
  if (filters.status) where.status = filters.status;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to)   where.createdAt.lte = new Date(filters.to);
  }

  const records = await prisma.accountStatusRecord.findMany({
    where,
    include: { user: { select: { phoneNumber: true } } },
    orderBy: { createdAt: 'desc' },
    take: MAX_EXPORT_ROWS,
  });

  await writeAuditLog({
    actorType: 'administrator',
    actorId: actingAdminId,
    action: 'admin.compliance.account_status.exported',
    entityType: 'AccountStatusRecord',
    metadata: { filters, rows: records.length, capped: records.length >= MAX_EXPORT_ROWS },
    req,
  }).catch((err) => logger.error('Audit log failed for account status export', err.message));

  return toCsv(
    records.map((r) => ({ ...r, phoneNumber: r.user?.phoneNumber })),
    [
      { header: 'id',          accessor: 'id' },
      { header: 'userId',      accessor: 'userId' },
      { header: 'phoneNumber', accessor: 'phoneNumber' },
      { header: 'status',      accessor: 'status' },
      { header: 'reason',      accessor: 'reason' },
      { header: 'notes',       accessor: 'notes' },
      { header: 'initiatedBy', accessor: 'initiatedBy' },
      { header: 'approvedBy',  accessor: 'approvedBy' },
      { header: 'approvedAt',  accessor: (r) => isoDate(r.approvedAt) },
      { header: 'effectiveAt', accessor: (r) => isoDate(r.effectiveAt) },
      { header: 'createdAt',   accessor: (r) => isoDate(r.createdAt) },
    ],
  );
};

module.exports = {
  MAX_EXPORT_ROWS,
  buildUserEvidencePackage,
  exportWorkflowEventsCsv,
  exportKycEvidenceCsv,
  exportAccountStatusHistoryCsv,
};
