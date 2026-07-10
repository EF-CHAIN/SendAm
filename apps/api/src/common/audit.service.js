const logger = require('../utils/logger');
const prisma = require('./prisma');

const writeAuditLog = async ({ actorType = 'system', actorId, action, entityType, entityId, metadata = {}, req }) => {
  try {
    return await prisma.auditLog.create({
      data: {
        actorType,
        actorId,
        action,
        entityType,
        entityId,
        ipAddress: req?.ip,
        userAgent: req?.get?.('user-agent'),
        metadata,
      },
    });
  } catch (error) {
    logger.error('Failed to write audit log', error.message);
    return null;
  }
};

module.exports = {
  writeAuditLog,
};
