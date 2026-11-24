const crypto = require('crypto');
const logger = require('../utils/logger');
const prisma = require('./prisma');
const { getClientIp } = require('../config/proxy');
const env = require('../config/env');

const sha256 = (previousHash, recordData, timestamp) => crypto.createHash('sha256')
  .update(`${previousHash || ''}${JSON.stringify(recordData)}${timestamp.toISOString()}`)
  .digest('hex');

const legacyHmac = (previousHash, data) => {
  const secret = env.encryptionKey || 'audit-secret-fallback';
  return crypto.createHmac('sha256', secret)
    .update(JSON.stringify({ previousHash, ...data }))
    .digest('hex');
};

const matchesLegacyHash = (log, data) => {
  const optionalFields = ['actorId', 'entityType', 'entityId', 'ipAddress', 'userAgent'];
  for (let mask = 0; mask < (1 << optionalFields.length); mask += 1) {
    const candidate = { ...data };
    optionalFields.forEach((field, index) => {
      if ((mask & (1 << index)) && candidate[field] === null) delete candidate[field];
    });
    if (legacyHmac(log.previousHash, candidate) === log.hash) return true;
  }
  return false;
};

const auditRecordData = (log) => ({
  actorType: log.actorType,
  actorId: log.actorId,
  action: log.action,
  entityType: log.entityType,
  entityId: log.entityId,
  ipAddress: log.ipAddress,
  userAgent: log.userAgent,
  metadata: log.metadata,
});

const writeAuditLog = async ({
  actorType = 'system',
  actorId,
  action,
  entityType,
  entityId,
  metadata = {},
  req,
}) => {
  const data = {
    actorType,
    actorId: actorId ?? null,
    action,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
    ipAddress: getClientIp(req) ?? null,
    userAgent: req?.get?.('user-agent') ?? null,
    metadata,
  };

  try {
    if (typeof prisma.$transaction !== 'function') {
      throw new Error('Audit chaining requires transactional database support.');
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx) => {
          const head = await tx.auditChainHead.findUnique({ where: { id: 'primary' } });
          let previousHash = head?.currentHash || null;
          if (!head) {
            const lastLog = await tx.auditLog.findFirst({
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            });
            previousHash = lastLog?.currentHash || lastLog?.hash || null;
          }
          const createdAt = new Date();
          const currentHash = sha256(previousHash, data, createdAt);
          const record = await tx.auditLog.create({
            data: {
              ...data,
              createdAt,
              previousHash,
              currentHash,
              hash: currentHash,
              hashAlgorithm: 'sha256',
            },
          });
          if (head) {
            await tx.auditChainHead.update({
              where: { id: 'primary' },
              data: { currentHash },
            });
          } else {
            await tx.auditChainHead.create({
              data: { id: 'primary', currentHash },
            });
          }
          return record;
        }, { isolationLevel: 'Serializable' });
      } catch (error) {
        if (attempt < 2 && ['P2002', 'P2034'].includes(error?.code)) continue;
        throw error;
      }
    }
    throw new Error('Could not append audit record after transaction retries.');
  } catch (error) {
    logger.error('Failed to write audit log', error.message);
    return null;
  }
};

const verifyAuditLogIntegrity = async () => {
  const head = await prisma.auditChainHead.findUnique({ where: { id: 'primary' } });
  const logs = await prisma.auditLog.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (logs.length === 0) {
    const errors = head?.currentHash
      ? [{ issue: 'Audit chain head points to a deleted record' }]
      : [];
    return { valid: errors.length === 0, errors };
  }

  const errors = [];
  if (!head) errors.push({ issue: 'Audit chain head is missing' });
  const hashToLog = new Map();
  const childrenByPreviousHash = new Map();
  const genesis = [];

  for (const log of logs) {
    const currentHash = log.currentHash || log.hash;
    if (!currentHash) {
      errors.push({ id: log.id, issue: 'Missing record hash' });
      continue;
    }
    if (hashToLog.has(currentHash)) {
      errors.push({ id: log.id, issue: 'Duplicate record hash' });
    } else {
      hashToLog.set(currentHash, log);
    }

    if (log.previousHash === null) {
      genesis.push(log);
    } else {
      const children = childrenByPreviousHash.get(log.previousHash) || [];
      children.push(log);
      childrenByPreviousHash.set(log.previousHash, children);
    }

    if (log.hashAlgorithm === 'sha256') {
      const expected = sha256(log.previousHash, auditRecordData(log), new Date(log.createdAt));
      if (expected !== currentHash || (log.hash && log.hash !== currentHash)) {
        errors.push({ id: log.id, issue: 'Hash mismatch: record altered' });
      }
    } else {
      if (!matchesLegacyHash(log, auditRecordData(log)) || (log.currentHash && log.currentHash !== log.hash)) {
        errors.push({ id: log.id, issue: 'Hash mismatch: legacy record altered' });
      }
    }
  }

  if (genesis.length !== 1) {
    errors.push({ issue: `Expected one genesis record; found ${genesis.length}` });
  }
  for (const log of logs) {
    if (log.previousHash !== null && !hashToLog.has(log.previousHash)) {
      errors.push({ id: log.id, issue: 'Chain broken: previous record deleted or missing' });
    }
  }

  if (genesis.length === 1) {
    const visited = new Set();
    let current = genesis[0];
    let tailHash = null;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const currentHash = current.currentHash || current.hash;
      const children = childrenByPreviousHash.get(currentHash) || [];
      if (children.length > 1) {
        errors.push({ id: current.id, issue: 'Chain branches after this record' });
        break;
      }
      tailHash = currentHash;
      current = children[0];
    }
    if (visited.size !== logs.length) {
      errors.push({ issue: `Chain contains ${logs.length - visited.size} unreachable record(s)` });
    }
    if (head && head.currentHash !== tailHash) {
      errors.push({ issue: 'Audit chain head does not match the final record' });
    }
  }

  if (errors.length > 0) logger.error('Audit log integrity check failed', { errors });
  return { valid: errors.length === 0, errors };
};

module.exports = {
  writeAuditLog,
  verifyAuditLogIntegrity,
};
