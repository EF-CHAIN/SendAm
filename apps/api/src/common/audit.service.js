const crypto = require('crypto');
const logger = require('../utils/logger');
const prisma = require('./prisma');
const { getClientIp } = require('../config/proxy');

const writeAuditLog = async ({ actorType = 'system', actorId, action, entityType, entityId, metadata = {}, req }) => {
  try {
    return await prisma.auditLog.create({
      data: {
        actorType,
        actorId,
        action,
        entityType,
        entityId,
        ipAddress: getClientIp(req),
        userAgent: req?.get?.('user-agent'),
        metadata,
      },
    });
  } catch (error) {
    logger.error('Failed to write audit log', error.message);
    return null;
  }
};

const verifyAuditLogIntegrity = async () => {
  const logs = await prisma.auditLog.findMany();
  
  if (logs.length === 0) return { valid: true, errors: [] };

  const hashSet = new Set(logs.map(l => l.hash));
  let nullPreviousCount = 0;
  const errors = [];
  const secret = env.encryptionKey || 'audit-secret-fallback';

  for (const log of logs) {
    const data = {
      actorType: log.actorType,
      actorId: log.actorId,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      metadata: log.metadata,
    };
    const payload = JSON.stringify({ previousHash: log.previousHash, ...data });
    const computedHash = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    if (computedHash !== log.hash) {
      errors.push({ id: log.id, issue: 'Hash mismatch: record altered' });
    }

    if (log.previousHash === null) {
      nullPreviousCount++;
    } else if (!hashSet.has(log.previousHash)) {
      errors.push({ id: log.id, issue: 'Chain broken: previous record deleted or missing' });
    }
  }

  if (nullPreviousCount > 1) {
    errors.push({ issue: `Multiple genesis records found (${nullPreviousCount})` });
  } else if (nullPreviousCount === 0 && logs.length > 0) {
    errors.push({ issue: 'No genesis record found (chain is circular or genesis deleted)' });
  }

  if (errors.length > 0) {
    logger.error('Audit log integrity check failed', { errors });
  }

  return { valid: errors.length === 0, errors };
};

module.exports = {
  writeAuditLog,
  verifyAuditLogIntegrity,
};
