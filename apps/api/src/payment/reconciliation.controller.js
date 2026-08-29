const logger = require('../utils/logger');
const { response } = require('../utils/response');
const { reconcileStaleTransactions, listLedgerDiscrepancies, listStuckPayments, operatorResolveStuckPayment } = require('./payment.reconciler');

const triggerReconciliation = async (req, res) => {
  try {
    const { type = 'full_cycle', staleAgeMs = 5 * 60 * 1000, maxTransactions = 50 } = req.body;
    const adminId = req.user?.id;

    if (!['wallet_ledger', 'ledger_database', 'full_cycle'].includes(type)) {
      return response(res, 400, { success: false, message: 'Invalid reconciliation type' });
    }

    const result = await reconcileStaleTransactions({
      prisma: req.app.locals.prisma,
      staleAgeMs,
      maxTransactions,
    });

    // Log reconciliation action for audit trail
    if (req.app.locals.auditLog) {
      await req.app.locals.auditLog({
        actorType: 'administrator',
        actorId: adminId,
        action: 'reconciliation.trigger',
        metadata: { type, processedCount: result.processedCount, updatedCount: result.updatedCount },
      });
    }

    return response(res, 200, {
      success: true,
      message: 'Reconciliation job initiated',
      data: {
        type,
        processedCount: result.processedCount,
        updatedCount: result.updatedCount,
      },
    });
  } catch (err) {
    logger.error('Error triggering reconciliation', err.message);
    return response(res, 500, { success: false, message: 'Failed to trigger reconciliation' });
  }
};

const getLedgerDiscrepancies = async (req, res) => {
  try {
    const { maxEntries = 500 } = req.query;

    const result = await listLedgerDiscrepancies({
      prisma: req.app.locals.prisma,
      maxEntries: parseInt(maxEntries, 10),
    });

    return response(res, 200, {
      success: true,
      data: {
        checkedCount: result.checkedCount,
        discrepancyCount: result.discrepancyCount,
        discrepancies: result.discrepancies.slice(0, 100), // Limit response size
      },
    });
  } catch (err) {
    logger.error('Error fetching ledger discrepancies', err.message);
    return response(res, 500, { success: false, message: 'Failed to fetch discrepancies' });
  }
};

const listReconciliationCheckpoints = async (req, res) => {
  try {
    const { transactionId, status = 'mismatch', limit = 50, cursor } = req.query;

    const where = {};
    if (transactionId) where.transactionId = transactionId;
    if (status) where.status = status;

    const checkpoints = await req.app.locals.prisma.reconciliationCheckpoint.findMany({
      where,
      take: parseInt(limit, 10),
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { transaction: { select: { id: true, amount: true, status: true } } },
    });

    return response(res, 200, {
      success: true,
      data: checkpoints,
    });
  } catch (err) {
    logger.error('Error fetching reconciliation checkpoints', err.message);
    return response(res, 500, { success: false, message: 'Failed to fetch checkpoints' });
  }
};

const resolveReconciliationMismatch = async (req, res) => {
  try {
    const { checkpointId } = req.params;
    const { resolution, reason } = req.body;
    const adminId = req.user?.id;

    if (!['accept_wallet', 'accept_ledger', 'accept_database', 'manual_review'].includes(resolution)) {
      return response(res, 400, { success: false, message: 'Invalid resolution action' });
    }

    const checkpoint = await req.app.locals.prisma.reconciliationCheckpoint.findUnique({
      where: { id: checkpointId },
    });

    if (!checkpoint) {
      return response(res, 404, { success: false, message: 'Checkpoint not found' });
    }

    if (checkpoint.status !== 'mismatch') {
      return response(res, 400, { success: false, message: 'Can only resolve checkpoints with mismatch status' });
    }

    const updated = await req.app.locals.prisma.reconciliationCheckpoint.update({
      where: { id: checkpointId },
      data: {
        status: 'success',
        resolvedBy: adminId,
        resolvedAt: new Date(),
        mismatchDetails: {
          ...checkpoint.mismatchDetails,
          resolution,
          reason,
          resolvedAt: new Date().toISOString(),
        },
      },
    });

    // Log resolution for audit trail
    if (req.app.locals.auditLog) {
      await req.app.locals.auditLog({
        actorType: 'administrator',
        actorId: adminId,
        action: 'reconciliation.resolve',
        entityType: 'ReconciliationCheckpoint',
        entityId: checkpointId,
        metadata: { resolution, reason, transactionId: checkpoint.transactionId },
      });
    }

    return response(res, 200, {
      success: true,
      message: 'Checkpoint resolved successfully',
      data: updated,
    });
  } catch (err) {
    logger.error('Error resolving checkpoint', err.message);
    return response(res, 500, { success: false, message: 'Failed to resolve checkpoint' });
  }
};

module.exports = {
  triggerReconciliation,
  getLedgerDiscrepancies,
  listReconciliationCheckpoints,
  resolveReconciliationMismatch,
};
