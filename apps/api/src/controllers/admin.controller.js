const { sendSuccess, sendError, sendCursorPaginated } = require('../utils/response');
const { authenticate, createInvitation, acceptInvitation, revokeSessions, hashPassword, changeOwnPassword } = require('../services/adminAuth.service');
const { writeAuditLog } = require('../common/audit.service');
const { appendEvent, EVENT_TYPES, queryEvents, verifyEventChain: verifyEventChainService } = require('../common/event.service');
const { deactivateAccount, reactivateAccount, getAccountStatusHistory, DEACTIVATION_REASONS } = require('../compliance/account.service');
const { getOnboardingStatus } = require('../compliance/onboarding.service');
const { buildUserEvidencePackage, exportWorkflowEventsCsv, exportKycEvidenceCsv, exportAccountStatusHistoryCsv } = require('../compliance/evidence.service');
const prisma = require('../common/prisma');
const { withIdAliases } = require('../common/records');
const { parseLimit, cursorQuery, MAX_EXPORT_ROWS } = require('../utils/cursorPagination');
const { listStuckPayments, operatorResolveStuckPayment, listLedgerDiscrepancies } = require('../payment/payment.reconciler');

// Build an inclusive [gte, lte] range from `from`/`to` query params. Tolerant of
// bare dates ("2024-01-01") and full ISO timestamps; invalid input is ignored
// so a bad filter never returns a hard error.
const parseDateRange = (query, field = 'createdAt') => {
  const { from, to, [field]: fieldRange } = query;
  const start = from || (fieldRange ? fieldRange.split(',')[0] : null);
  const end = to || (fieldRange ? fieldRange.split(',')[1] : null);
  const range = {};
  if (start) {
    const d = new Date(start);
    if (!Number.isNaN(d.getTime())) range.gte = d;
  }
  if (end) {
    const d = new Date(end);
    if (!Number.isNaN(d.getTime())) range.lte = d;
  }
  return Object.keys(range).length ? { [field]: range } : {};
};

// Turn a free-text identifier into an OR across the common lookup columns.
const identifierWhere = (value, fields) => {
  if (!value) return {};
  const trimmed = String(value).trim();
  if (!trimmed) return {};
  return {
    OR: fields.map((f) => ({ [f]: { equals: trimmed } })),
  };
};

const userWhere = (query) => {
  const where = {};
  if (query.phone) where.phoneNumber = { contains: query.phone, mode: 'insensitive' };
  Object.assign(where, parseDateRange(query, 'createdAt'));
  return where;
};

const walletWhere = (query) => {
  const where = {};
  if (query.chain) where.chain = { equals: query.chain };
  if (query.fundingState) where.fundingState = { equals: query.fundingState };
  Object.assign(where, parseDateRange(query, 'createdAt'));
  if (query.phone) {
    where.OR = [
      { phoneNumber: { contains: query.phone, mode: 'insensitive' } },
      { user: { phoneNumber: { contains: query.phone, mode: 'insensitive' } } },
    ];
  }
  return where;
};

const transactionWhere = (query) => {
  const where = {};
  if (query.status) where.status = { equals: query.status };
  if (query.asset) where.asset = { equals: query.asset };
  if (query.rail) where.rail = { equals: query.rail };
  Object.assign(where, parseDateRange(query, 'createdAt'));
  if (query.userId) where.userId = { equals: query.userId };
  if (query.phone) where.user = { phoneNumber: { contains: query.phone, mode: 'insensitive' } };
  Object.assign(where, identifierWhere(query.identifier, ['id', 'txHash', 'providerTransactionId']));
  return where;
};

const kycWhere = (query) => {
  const where = {};
  if (query.status) where.status = { equals: query.status };
  if (query.country) where.country = { equals: query.country };
  Object.assign(where, parseDateRange(query, 'updatedAt'));
  if (query.phone) where.user = { phoneNumber: { contains: query.phone, mode: 'insensitive' } };
  return where;
};

const auditWhere = (query) => {
  const where = {};
  if (query.action) where.action = { equals: query.action };
  if (query.actorType) where.actorType = { equals: query.actorType };
  if (query.entityType) where.entityType = { equals: query.entityType };
  Object.assign(where, parseDateRange(query, 'createdAt'));
  Object.assign(where, identifierWhere(query.identifier, ['id', 'entityId']));
  return where;
};

// Minimal RFC-4180-ish CSV serializer for exports.
const toCsv = (rows, columns) => {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = columns.map((c) => escape(c.header)).join(',');
  const body = rows
    .map((row) => columns.map((c) => escape(typeof c.accessor === 'function' ? c.accessor(row) : row[c.accessor])).join(','))
    .join('\n');
  return `${header}\n${body}\n`;
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const result = await authenticate(email, password);
    if (!result) {
      await writeAuditLog({ actorType: 'anonymous', action: 'admin.login.denied', metadata: { email: String(email || '').toLowerCase() }, req });
      return sendError(res, 'Invalid credentials', 401);
    }
    await writeAuditLog({ actorType: 'administrator', actorId: result.admin.id, action: 'admin.login.succeeded', entityType: 'AdminSession', entityId: result.session.id, req });
    return sendSuccess(res, { token: result.token, mustChangePassword: result.mustChangePassword === true, administrator: { id: result.admin.id, email: result.admin.email, name: result.admin.name, role: result.admin.role.name } }, 'Login successful');
  } catch (error) {
    next(error);
  }
};

const acceptInvite = async (req, res, next) => {
  try {
    const admin = await acceptInvitation(req.body?.token, req.body?.password);
    await writeAuditLog({ actorType: 'administrator', actorId: admin.id, action: 'admin.invitation.accepted', entityType: 'AdminUser', entityId: admin.id, req });
    return sendSuccess(res, null, 'Account created', 201);
  } catch (error) { if (error.statusCode) return sendError(res, error.message, error.statusCode); return next(error); }
};

const listAdministrators = async (_req, res, next) => {
  try {
    const admins = await prisma.adminUser.findMany({ select: { id: true, email: true, name: true, disabledAt: true, lastLoginAt: true, createdAt: true, role: { select: { name: true, permissions: true } } }, orderBy: { createdAt: 'asc' } });
    return sendSuccess(res, admins);
  } catch (error) { return next(error); }
};

const inviteAdministrator = async (req, res, next) => {
  try {
    const { invitation, token } = await createInvitation({ email: req.body?.email, name: req.body?.name, roleName: req.body?.role, createdById: req.admin.id });
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.invitation.created', entityType: 'AdminInvitation', entityId: invitation.id, metadata: { email: invitation.email }, req });
    return sendSuccess(res, { invitationId: invitation.id, token, expiresAt: invitation.expiresAt }, 'Invitation created', 201);
  } catch (error) { if (error.statusCode) return sendError(res, error.message, error.statusCode); return next(error); }
};

const enabledAdministratorCount = () => prisma.adminUser.count({ where: { disabledAt: null, role: { name: 'administrator' } } });
const updateAdministratorRole = async (req, res, next) => {
  try {
    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id }, include: { role: true } });
    const role = await prisma.adminRole.findUnique({ where: { name: req.body?.role } });
    if (!target || !role) return sendError(res, 'Administrator or role not found', 404);
    if (target.role.name === 'administrator' && role.name !== 'administrator' && await enabledAdministratorCount() <= 1) return sendError(res, 'Cannot remove the last enabled administrator', 409);
    await prisma.adminUser.update({ where: { id: target.id }, data: { roleId: role.id } });
    await revokeSessions(target.id);
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.role.changed', entityType: 'AdminUser', entityId: target.id, metadata: { from: target.role.name, to: role.name }, req });
    return sendSuccess(res, null, 'Role updated; active sessions revoked');
  } catch (error) { return next(error); }
};

const disableAdministrator = async (req, res, next) => {
  try {
    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id }, include: { role: true } });
    if (!target) return sendError(res, 'Administrator not found', 404);
    if (target.role.name === 'administrator' && !target.disabledAt && await enabledAdministratorCount() <= 1) return sendError(res, 'Cannot disable the last enabled administrator', 409);
    await prisma.adminUser.update({ where: { id: target.id }, data: { disabledAt: new Date() } }); await revokeSessions(target.id);
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.account.disabled', entityType: 'AdminUser', entityId: target.id, req });
    return sendSuccess(res, null, 'Administrator disabled');
  } catch (error) { return next(error); }
};

const resetCredential = async (req, res, next) => {
  try {
    const passwordHash = await hashPassword(req.body?.password);
    const target = await prisma.adminUser.update({ where: { id: req.params.id }, data: { passwordHash, passwordChangedAt: new Date() } }); await revokeSessions(target.id);
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.credential.reset', entityType: 'AdminUser', entityId: target.id, req });
    return sendSuccess(res, null, 'Credential reset; active sessions revoked');
  } catch (error) { if (error.statusCode) return sendError(res, error.message, error.statusCode); return next(error); }
};

const revokeAdministratorSessions = async (req, res, next) => {
  try {
    await revokeSessions(req.params.id);
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.sessions.revoked', entityType: 'AdminUser', entityId: req.params.id, req });
    return sendSuccess(res, null, 'Sessions revoked');
  } catch (error) { return next(error); }
};

const logout = async (req, res, next) => {
  try {
    await prisma.adminSession.update({ where: { id: req.admin.sessionId }, data: { revokedAt: new Date() } });
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.session.revoked', entityType: 'AdminSession', entityId: req.admin.sessionId, req });
    return sendSuccess(res, null, 'Logged out');
  } catch (error) { return next(error); }
};

// Allows an operator to rotate to a private password (or change it later), the
// required first step after a bootstrap/temporary credential. All other active
// sessions are revoked so a leaked shared token cannot continue to act, and the
// change itself is attributed to the operator.
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const admin = await changeOwnPassword({
      adminId: req.admin.id,
      currentPassword,
      newPassword,
      sessionId: req.admin.sessionId,
    });
    await writeAuditLog({ actorType: 'administrator', actorId: admin.id, action: 'admin.password.changed', entityType: 'AdminUser', entityId: admin.id, req });
    return sendSuccess(res, null, 'Password changed');
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode, { code: 'PASSWORD_CHANGE_FAILED' });
    return next(error);
  }
};

const me = async (req, res, next) => {
  try {
    return sendSuccess(res, {
      id: req.admin.id,
      email: req.admin.email,
      name: req.admin.name,
      role: req.admin.role,
      permissions: req.admin.permissions,
      mustChangePassword: req.admin.mustChangePassword === true,
    });
  } catch (error) { return next(error); }
};

const getStats = async (req, res, next) => {
  try {
    const [
      totalUsers,
      totalWallets,
      totalTransactions,
      successfulTransactions,
      failedTransactions,
      pendingTransactions,
      pendingKyc,
      voiceCommands,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.wallet.count(),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: 'success' } }),
      prisma.transaction.count({ where: { status: 'failed' } }),
      prisma.transaction.count({ where: { status: { in: ['pending', 'processing'] } } }),
      prisma.kycProfile.count({ where: { status: { in: ['pending', 'review'] } } }),
      prisma.voiceCommand.count(),
    ]);

    sendSuccess(res, {
      totalUsers,
      totalWallets,
      totalTransactions,
      successfulTransactions,
      failedTransactions,
      pendingTransactions,
      pendingKyc,
      voiceCommands,
    });
  } catch (error) {
    next(error);
  }
};

const getUsers = async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit);
    const where = userWhere(req.query);
    const [result, total] = await Promise.all([
      cursorQuery({
        delegate: prisma.user,
        where,
        orderBy: { createdAt: 'desc' },
        sortField: 'createdAt',
        include: { wallets: { select: { chain: true, publicKey: true, network: true, createdAt: true } } },
        limit,
        after: req.query.after,
        before: req.query.before,
      }),
      prisma.user.count({ where }),
    ]);
    const items = withIdAliases(result.items.map((user) => ({ ...user, pinHash: undefined })));
    sendCursorPaginated(res, items, { limit, nextCursor: result.nextCursor, prevCursor: result.prevCursor, total });
  } catch (error) { return next(error); }
};

const getWallets = async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit);
    const where = walletWhere(req.query);
    const [result, total] = await Promise.all([
      cursorQuery({
        delegate: prisma.wallet,
        where,
        orderBy: { createdAt: 'desc' },
        sortField: 'createdAt',
        include: { user: { select: { phoneNumber: true, whatsappName: true } } },
        limit,
        after: req.query.after,
        before: req.query.before,
      }),
      prisma.wallet.count({ where }),
    ]);
    const items = withIdAliases(result.items.map((wallet) => ({ ...wallet, encryptedSecretKey: undefined, userId: wallet.user })));
    sendCursorPaginated(res, items, { limit, nextCursor: result.nextCursor, prevCursor: result.prevCursor, total });
  } catch (error) { return next(error); }
};

const getTransaction = async (req, res, next) => {
  try {
    const tx = await prisma.transaction.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { phoneNumber: true } } },
    });
    if (!tx) return sendError(res, 'Transaction not found', 404);
    const item = withIdAliases([{ ...tx, userId: tx.user }])[0];
    return sendSuccess(res, item);
  } catch (error) {
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit);
    const where = transactionWhere(req.query);
    const [result, total] = await Promise.all([
      cursorQuery({
        delegate: prisma.transaction,
        where,
        orderBy: { createdAt: 'desc' },
        sortField: 'createdAt',
        include: { user: { select: { phoneNumber: true } } },
        limit,
        after: req.query.after,
        before: req.query.before,
      }),
      prisma.transaction.count({ where }),
    ]);
    const items = withIdAliases(result.items.map((transaction) => ({ ...transaction, userId: transaction.user })));
    sendCursorPaginated(res, items, { limit, nextCursor: result.nextCursor, prevCursor: result.prevCursor, total });
  } catch (error) { return next(error); }
};

const getKycProfiles = async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit);
    const where = kycWhere(req.query);
    const [result, total] = await Promise.all([
      cursorQuery({
        delegate: prisma.kycProfile,
        where,
        orderBy: { updatedAt: 'desc' },
        sortField: 'updatedAt',
        include: { user: { select: { phoneNumber: true, whatsappName: true } } },
        limit,
        after: req.query.after,
        before: req.query.before,
      }),
      prisma.kycProfile.count({ where }),
    ]);
    const items = withIdAliases(result.items.map((profile) => ({ ...profile, userId: profile.user })));
    sendCursorPaginated(res, items, { limit, nextCursor: result.nextCursor, prevCursor: result.prevCursor, total });
  } catch (error) { return next(error); }
};

const getAuditLogs = async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit);
    const where = auditWhere(req.query);
    const [result, total] = await Promise.all([
      cursorQuery({
        delegate: prisma.auditLog,
        where,
        orderBy: { createdAt: 'desc' },
        sortField: 'createdAt',
        limit,
        after: req.query.after,
        before: req.query.before,
      }),
      prisma.auditLog.count({ where }),
    ]);
    const items = withIdAliases(result.items);
    sendCursorPaginated(res, items, { limit, nextCursor: result.nextCursor, prevCursor: result.prevCursor, total });
  } catch (error) { return next(error); }
};

// Sensitive exports: authorized (route-level requireAdmin), bounded so a single
// request can never dump the whole table, and always recorded to the audit log.
const exportKyc = async (req, res, next) => {
  try {
    const where = kycWhere(req.query);
    const profiles = await prisma.kycProfile.findMany({
      where,
      include: { user: { select: { phoneNumber: true, whatsappName: true } } },
      orderBy: { updatedAt: 'desc' },
      take: MAX_EXPORT_ROWS,
    });
    await writeAuditLog({
      actorType: 'administrator',
      actorId: req.admin.id,
      action: 'admin.kyc.export',
      entityType: 'KycProfile',
      metadata: { filters: req.query, rows: profiles.length, capped: profiles.length >= MAX_EXPORT_ROWS },
      req,
    });
    const csv = toCsv(
      profiles.map((p) => ({ ...p, phoneNumber: p.user?.phoneNumber, whatsappName: p.user?.whatsappName })),
      [
        { header: 'id', accessor: 'id' },
        { header: 'phoneNumber', accessor: 'phoneNumber' },
        { header: 'provider', accessor: 'provider' },
        { header: 'tier', accessor: 'tier' },
        { header: 'status', accessor: 'status' },
        { header: 'country', accessor: 'country' },
        { header: 'riskScore', accessor: 'riskScore' },
        { header: 'updatedAt', accessor: (r) => r.updatedAt?.toISOString?.() || r.updatedAt },
      ]
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kyc-export.csv"');
    return res.status(200).send(csv);
  } catch (error) { return next(error); }
};

const exportAuditLogs = async (req, res, next) => {
  try {
    const where = auditWhere(req.query);
    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: MAX_EXPORT_ROWS,
    });
    await writeAuditLog({
      actorType: 'administrator',
      actorId: req.admin.id,
      action: 'admin.audit.export',
      entityType: 'AuditLog',
      metadata: { filters: req.query, rows: logs.length, capped: logs.length >= MAX_EXPORT_ROWS },
      req,
    });
    const csv = toCsv(logs, [
      { header: 'id', accessor: 'id' },
      { header: 'actorType', accessor: 'actorType' },
      { header: 'actorId', accessor: 'actorId' },
      { header: 'action', accessor: 'action' },
      { header: 'entityType', accessor: 'entityType' },
      { header: 'entityId', accessor: 'entityId' },
      { header: 'ipAddress', accessor: 'ipAddress' },
      { header: 'createdAt', accessor: (r) => r.createdAt?.toISOString?.() || r.createdAt },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs-export.csv"');
    return res.status(200).send(csv);
  } catch (error) { return next(error); }
};

const getSystemHealth = async (_req, res, next) => {
  try {
    sendSuccess(res, {
      api: 'ok',
      database: 'ok',
      queues: process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL ? 'redis-configured' : 'unavailable',
      settlementRail: 'stellar',
      custodyModel: 'direct',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
};

const refundTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason, amount } = req.body;
    const adminId = req.admin ? req.admin.id : 'system';

    const { executeRefund } = require('../payment/payment.orchestrator');

    const refund = await executeRefund({
      transactionId: id,
      reason,
      amount,
      adminId,
    });

    return sendSuccess(res, { refund }, 'Refund executed successfully');
  } catch (error) {
    next(error);
  }
};
const getStuckPayments = async (req, res, next) => {
  try {
    const staleAgeMs = req.query.staleAgeMs ? Number(req.query.staleAgeMs) : undefined;
    const maxTransactions = req.query.limit ? parseLimit(req.query.limit) : undefined;
    const payments = await listStuckPayments({ prisma, staleAgeMs, maxTransactions });
    return sendSuccess(res, payments);
  } catch (error) {
    next(error);
  }
};

const actOnStuckPayment = (action) => async (req, res, next) => {
  try {
    const transaction = await operatorResolveStuckPayment({
      prisma,
      transactionId: req.params.id,
      action,
      reason: req.body?.reason,
      adminId: req.admin?.id || 'system',
    });
    return sendSuccess(res, { transaction }, 'Stuck payment updated');
  } catch (error) {
    next(error);
  }
};

const getLedgerDiscrepancies = async (req, res, next) => {
  try {
    const report = await listLedgerDiscrepancies({ prisma, maxEntries: req.query.limit ? parseLimit(req.query.limit) : undefined });
    return sendSuccess(res, report);
  } catch (error) {
    next(error);
  }
};

const verifyAuditLogs = async (req, res, next) => {
  try {
    const { verifyAuditLogIntegrity } = require('../common/audit.service');
    const result = await verifyAuditLogIntegrity();

    await writeAuditLog({
      actorType: 'administrator',
      actorId: req.admin.id,
      action: 'admin.audit.verify',
      entityType: 'System',
      metadata: { valid: result.valid, errorCount: result.errors.length },
      req,
    });

    if (!result.valid) {
      return sendError(res, 'Audit log integrity verification failed', 409, { errors: result.errors });
    }

    return sendSuccess(res, { valid: true }, 'Audit log integrity verified successfully');
  } catch (error) {
    next(error);
  }
};

// ── Issue #318: Workflow event ledger ────────────────────────────────────────

const getWorkflowEvents = async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit);
    const result = await queryEvents({
      eventType: req.query.eventType,
      actorType: req.query.actorType,
      actorId: req.query.actorId,
      aggregateType: req.query.aggregateType,
      from: req.query.from,
      to: req.query.to,
      limit,
      after: req.query.after,
    });
    return sendSuccess(res, { items: result.items, nextCursor: result.nextCursor });
  } catch (error) {
    next(error);
  }
};

const verifyEventChain = async (req, res, next) => {
  try {
    const result = await verifyEventChainService();
    await writeAuditLog({
      actorType: 'administrator',
      actorId: req.admin.id,
      action: 'admin.events.verify',
      entityType: 'WorkflowEvent',
      metadata: { valid: result.valid, errorCount: result.errors.length, total: result.total },
      req,
    });
    if (!result.valid) {
      return sendError(res, 'Event chain integrity verification failed', 409, { errors: result.errors });
    }
    return sendSuccess(res, { valid: true, total: result.total }, 'Event chain verified successfully');
  } catch (error) {
    next(error);
  }
};

const exportWorkflowEvents = async (req, res, next) => {
  try {
    const csv = await exportWorkflowEventsCsv({
      filters: req.query,
      actingAdminId: req.admin.id,
      req,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="workflow-events-export.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    next(error);
  }
};

// ── Issue #329: Compliance evidence exports ──────────────────────────────────

const getUserEvidencePackage = async (req, res, next) => {
  try {
    const pkg = await buildUserEvidencePackage({
      userId: req.params.userId,
      actingAdminId: req.admin.id,
      req,
    });
    return sendSuccess(res, pkg);
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const downloadUserEvidencePackage = async (req, res, next) => {
  try {
    const pkg = await buildUserEvidencePackage({
      userId: req.params.userId,
      actingAdminId: req.admin.id,
      req,
    });
    const filename = `evidence-${req.params.userId}-${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(JSON.stringify(pkg, null, 2));
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const exportKycEvidence = async (req, res, next) => {
  try {
    const csv = await exportKycEvidenceCsv({
      filters: req.query,
      actingAdminId: req.admin.id,
      req,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kyc-evidence-export.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    next(error);
  }
};

const exportAccountStatusHistory = async (req, res, next) => {
  try {
    const csv = await exportAccountStatusHistoryCsv({
      filters: req.query,
      actingAdminId: req.admin.id,
      req,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="account-status-export.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    next(error);
  }
};

// ── Issue #330: Onboarding status (admin view) ───────────────────────────────

const getUserOnboardingStatus = async (req, res, next) => {
  try {
    const status = await getOnboardingStatus(req.params.userId);
    return sendSuccess(res, status);
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

// ── Issue #332: Account deactivation / reactivation ─────────────────────────

const deactivateUserAccount = async (req, res, next) => {
  try {
    const { reason, notes, force } = req.body || {};

    if (!reason) {
      return sendError(
        res,
        `Deactivation reason is required. Valid reasons: ${[...Object.values(DEACTIVATION_REASONS)].join(', ')}`,
        400,
      );
    }

    const { user, record } = await deactivateAccount({
      userId: req.params.userId,
      reason,
      notes,
      adminId: req.admin.id,
      force: Boolean(force),
      req,
    });

    return sendSuccess(
      res,
      { userId: user.id, deactivatedAt: user.deactivatedAt, reason, recordId: record.id },
      'Account deactivated',
    );
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const reactivateUserAccount = async (req, res, next) => {
  try {
    const { notes, approvedBy } = req.body || {};

    const { user, record } = await reactivateAccount({
      userId: req.params.userId,
      notes,
      adminId: req.admin.id,
      approvedBy,
      req,
    });

    return sendSuccess(
      res,
      { userId: user.id, deactivatedAt: null, recordId: record.id, approvedBy: record.approvedBy },
      'Account reactivated',
    );
  } catch (error) {
    if (error.statusCode) return sendError(res, error.message, error.statusCode);
    next(error);
  }
};

const getUserAccountStatusHistory = async (req, res, next) => {
  try {
    const history = await getAccountStatusHistory(req.params.userId);
    return sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login,
  acceptInvite,
  logout,
  changePassword,
  me,
  listAdministrators,
  inviteAdministrator,
  updateAdministratorRole,
  disableAdministrator,
  resetCredential,
  revokeAdministratorSessions,
  getStats,
  getUsers,
  getWallets,
  getTransaction,
  getTransactions,
  getKycProfiles,
  getAuditLogs,
  exportKyc,
  exportAuditLogs,
  getSystemHealth,
  refundTransaction,
  getStuckPayments,
  retryStuckPayment: actOnStuckPayment('retry'),
  markStuckPaymentResolved: actOnStuckPayment('mark_resolved'),
  escalateStuckPayment: actOnStuckPayment('escalate'),
  getLedgerDiscrepancies,
  verifyAuditLogs,
  // #318 – Event ledger
  getWorkflowEvents,
  verifyEventChain,
  exportWorkflowEvents,
  // #329 – Compliance evidence exports
  getUserEvidencePackage,
  downloadUserEvidencePackage,
  exportKycEvidence,
  exportAccountStatusHistory,
  // #330 – Onboarding status
  getUserOnboardingStatus,
  // #332 – Account deactivation/reactivation
  deactivateUserAccount,
  reactivateUserAccount,
  getUserAccountStatusHistory,
};
