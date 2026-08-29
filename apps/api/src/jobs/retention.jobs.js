'use strict';

// Scheduled enforcement of the retention windows in
// `compliance/retentionPolicy.js` (#315).

const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');
const {
  PURGEABLE_MODELS,
  policyFor,
  cutoffFor,
  guardClauseFor,
} = require('../compliance/retentionPolicy');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Prisma delegate name for a model (`Notification` → `notification`). */
const delegateFor = (db, model) => db[model.charAt(0).toLowerCase() + model.slice(1)] || null;

/**
 * Users whose data must not be touched, because a legal hold suspends
 * retention for them.
 *
 * Resolved once per sweep and applied to every model that carries a `userId`.
 * Purging a held customer's records would destroy the evidence the hold exists
 * to preserve, which is not recoverable and is exactly the kind of failure a
 * scheduled job must not be able to cause.
 */
const heldUserIds = async (db) => {
  const now = new Date();
  const holds = await db.legalHold.findMany({
    where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { userId: true },
  });
  return [...new Set(holds.map((hold) => hold.userId).filter(Boolean))];
};

/** Whether a model's rows are attributable to a user, and so hold-protected. */
const HAS_USER_ID = new Set(['Notification', 'VoiceCommand', 'RestSession']);

/**
 * Apply one model's retention policy.
 *
 * `dryRun` counts what would go without touching anything — the sweep should be
 * observable before it is trusted, and a first run in production that reports
 * "would delete 4.2M rows" is a conversation, not an incident.
 */
const purgeModel = async (model, { now = new Date(), dryRun = false, db = prisma, protectedUserIds = [] } = {}) => {
  const policy = policyFor(model);
  if (!policy) return { model, skipped: 'no_policy' };

  const delegate = delegateFor(db, model);
  if (!delegate) {
    // A model in the policy that is not in the schema is a policy bug, not a
    // reason to abort the whole sweep.
    logger.warn('retention_model_missing', { model });
    return { model, skipped: 'no_delegate' };
  }

  const cutoff = cutoffFor(model, now);
  const where = {
    [policy.timestampField]: { lt: cutoff },
    ...guardClauseFor(model, now),
  };

  if (protectedUserIds.length && HAS_USER_ID.has(model)) {
    where.userId = { notIn: protectedUserIds };
  }

  const eligible = await delegate.count({ where });
  if (dryRun || eligible === 0) {
    return { model, action: policy.action, cutoff, eligible, affected: 0, dryRun };
  }

  let affected = 0;
  if (policy.action === 'delete') {
    ({ count: affected } = await delegate.deleteMany({ where }));
  } else {
    // Redaction re-filters on a field that is still un-redacted, so a rerun
    // after a partial failure does not rewrite rows it already handled.
    ({ count: affected } = await delegate.updateMany({
      where,
      data: policy.redactFields,
    }));
  }

  increment('sendam_retention_records_total', { model, action: policy.action });
  return { model, action: policy.action, cutoff, eligible, affected, dryRun: false };
};

/**
 * Run every model's policy and report the outcome.
 *
 * One model failing does not stop the others: a lock contention on
 * notifications should not leave rate-limit rows growing for another day. The
 * failure is recorded in the report and counted, so a persistently failing
 * model is visible rather than silently skipped forever.
 */
const runRetentionSweep = async ({ now = new Date(), dryRun = false, db = prisma, models = PURGEABLE_MODELS } = {}) => {
  const startedAt = new Date();
  const protectedUserIds = await heldUserIds(db).catch((error) => {
    // If holds cannot be read, the safe answer is to purge nothing rather than
    // to purge everything — the failure mode of guessing wrong is unrecoverable.
    logger.error('retention_legal_holds_unavailable', { message: error.message });
    throw error;
  });

  const results = [];
  for (const model of models) {
    try {
      results.push(await purgeModel(model, { now, dryRun, db, protectedUserIds }));
    } catch (error) {
      increment('sendam_retention_failures_total', { model });
      logger.error('retention_model_failed', { model, message: error.message });
      results.push({ model, error: error.message });
    }
  }

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun,
    protectedUsers: protectedUserIds.length,
    totalAffected: results.reduce((sum, entry) => sum + (entry.affected || 0), 0),
    failures: results.filter((entry) => entry.error).length,
    results,
  };

  logger.info('retention_sweep_complete', report);

  // The sweep is the one job whose *absence* is invisible, so it records its
  // own run in the audit trail. An operator reviewing retention needs to see
  // that it ran and what it did, not infer it from row counts.
  try {
    await db.auditLog.create({
      data: {
        actorType: 'system',
        actorId: 'retention_sweep',
        action: dryRun ? 'retention_sweep_dry_run' : 'retention_sweep_executed',
        entityType: 'System',
        entityId: 'retention',
        metadata: {
          totalAffected: report.totalAffected,
          failures: report.failures,
          protectedUsers: report.protectedUsers,
          models: results.map(({ model, affected, eligible, error }) => ({ model, affected, eligible, error })),
        },
      },
    });
  } catch (auditError) {
    logger.error('retention_audit_write_failed', { message: auditError.message });
  }

  return report;
};

const startRetentionSweep = ({ intervalMs = DEFAULT_INTERVAL_MS, dryRun = process.env.RETENTION_DRY_RUN === 'true' } = {}) => {
  logger.info(`Retention sweep started (interval: ${intervalMs}ms, dryRun: ${dryRun})`);

  const runSweep = async () => {
    try {
      await runRetentionSweep({ dryRun });
    } catch (error) {
      logger.error('retention_sweep_failed', { message: error.message });
    }
  };

  // Deliberately not run on boot: a deploy loop would otherwise fire a purge
  // on every restart, and a retention sweep is not something to run more often
  // than the policy says.
  const timer = setInterval(runSweep, intervalMs);
  if (timer.unref) timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      logger.info('Retention sweep stopped.');
    },
    runSweep,
  };
};

module.exports = {
  DEFAULT_INTERVAL_MS,
  delegateFor,
  heldUserIds,
  purgeModel,
  runRetentionSweep,
  startRetentionSweep,
};
