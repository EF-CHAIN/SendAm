'use strict';

const prisma = require('../common/prisma');
const { writeAuditLog } = require('../common/audit.service');
const logger = require('../utils/logger');

/**
 * Check whether a user is under an active legal hold.
 *
 * Checks:
 * 1. user.legalHold === true on the User record
 * 2. An active (unreleased and non-expired) record in LegalHold table
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {object} [options.db=prisma]
 * @returns {Promise<boolean>}
 */
const isUnderLegalHold = async (userId, { db = prisma } = {}) => {
  if (!userId) return false;

  const [user, activeHold] = await Promise.all([
    db.user?.findUnique
      ? db.user.findUnique({
          where: { id: userId },
          select: { id: true, legalHold: true },
        }).catch(() => null)
      : null,
    db.legalHold?.findFirst
      ? db.legalHold.findFirst({
          where: {
            userId,
            releasedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } },
            ],
          },
        }).catch(() => null)
      : null,
  ]);

  return Boolean(user?.legalHold || activeHold);
};

/**
 * Get all user IDs currently protected under legal hold (either via
 * User.legalHold === true or an unreleased LegalHold record).
 *
 * @param {object} [options]
 * @param {object} [options.db=prisma]
 * @returns {Promise<string[]>}
 */
const getProtectedUserIds = async ({ db = prisma } = {}) => {
  const now = new Date();
  const [usersWithHold, activeHolds] = await Promise.all([
    db.user?.findMany
      ? db.user.findMany({
          where: { legalHold: true },
          select: { id: true },
        }).catch(() => [])
      : [],
    db.legalHold?.findMany
      ? db.legalHold.findMany({
          where: {
            releasedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          select: { userId: true },
        }).catch(() => [])
      : [],
  ]);

  const ids = new Set([
    ...(usersWithHold || []).map((u) => u.id),
    ...(activeHolds || []).map((h) => h.userId),
  ]);

  return [...ids].filter(Boolean);
};

/**
 * Enforce that a user is NOT under legal hold before deletion, erasure, or data purges.
 * If under legal hold, explicitly rejects the operation and records the attempt in the audit log.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {string} [options.operation='erasure'] - 'erasure' | 'purge' | 'delete' | 'anonymize'
 * @param {string} [options.actorType='system']
 * @param {string} [options.actorId]
 * @param {object} [options.req]
 * @param {object} [options.db=prisma]
 * @throws {Error} If user is under legal hold
 */
const assertNoLegalHold = async (userId, {
  operation = 'erasure',
  actorType = 'system',
  actorId = null,
  req = null,
  db = prisma,
} = {}) => {
  if (!userId) return;

  const underHold = await isUnderLegalHold(userId, { db });
  if (!underHold) return;

  logger.warn('legal_hold_enforcement_blocked_attempt', { userId, operation, actorType, actorId });

  try {
    await writeAuditLog({
      actorType,
      actorId: actorId || userId,
      action: 'compliance.legal_hold.attempt_blocked',
      entityType: 'User',
      entityId: userId,
      metadata: {
        operation,
        reason: 'active_legal_hold',
        blockedAt: new Date().toISOString(),
      },
      req,
    });
  } catch (err) {
    logger.error('failed_to_log_legal_hold_attempt_blocked', { error: err.message, userId });
  }

  const error = new Error(`Erasure and data purges are forbidden for user under legal hold (operation: ${operation}).`);
  error.statusCode = 409;
  error.code = 'LEGAL_HOLD_ACTIVE';
  throw error;
};

/**
 * Apply a legal hold to a user, setting User.legalHold = true and creating a LegalHold row.
 */
const setLegalHold = async ({
  userId,
  reason,
  heldBy,
  expiresAt = null,
  db = prisma,
  req = null,
} = {}) => {
  if (!userId) {
    const error = new Error('userId is required');
    error.statusCode = 400;
    throw error;
  }
  if (!reason || String(reason).trim().length < 5) {
    const error = new Error('A legal hold requires a descriptive reason');
    error.statusCode = 400;
    throw error;
  }

  const expiresDate = expiresAt ? new Date(expiresAt) : null;

  // Set User.legalHold = true and create the LegalHold record
  const [, hold] = await Promise.all([
    db.user?.update
      ? db.user.update({
          where: { id: userId },
          data: { legalHold: true },
        }).catch(() => null)
      : null,
    db.legalHold.create({
      data: {
        userId,
        reason: String(reason).trim(),
        heldBy,
        expiresAt: expiresDate,
      },
    }),
  ]);

  try {
    await writeAuditLog({
      actorType: 'administrator',
      actorId: heldBy,
      action: 'admin.legal_hold.set',
      entityType: 'LegalHold',
      entityId: hold.id,
      metadata: {
        userId,
        reason: String(reason).trim(),
        expiresAt: hold.expiresAt ? hold.expiresAt.toISOString() : null,
      },
      req,
    });
  } catch (err) {
    logger.error('failed_to_write_legal_hold_audit', { error: err.message });
  }

  return hold;
};

/**
 * Release all active legal holds on a user and reset User.legalHold = false.
 */
const releaseLegalHold = async ({
  userId,
  releasedBy,
  db = prisma,
  req = null,
} = {}) => {
  if (!userId) {
    const error = new Error('userId is required');
    error.statusCode = 400;
    throw error;
  }

  const [result] = await Promise.all([
    db.legalHold.updateMany({
      where: { userId, releasedAt: null },
      data: { releasedAt: new Date() },
    }),
    db.user?.update
      ? db.user.update({
          where: { id: userId },
          data: { legalHold: false },
        }).catch(() => null)
      : null,
  ]);

  try {
    await writeAuditLog({
      actorType: 'administrator',
      actorId: releasedBy,
      action: 'admin.legal_hold.released',
      entityType: 'LegalHold',
      entityId: userId,
      metadata: { released: result.count },
      req,
    });
  } catch (err) {
    logger.error('failed_to_write_legal_hold_audit', { error: err.message });
  }

  return result;
};

module.exports = {
  isUnderLegalHold,
  getProtectedUserIds,
  assertNoLegalHold,
  setLegalHold,
  releaseLegalHold,
};
