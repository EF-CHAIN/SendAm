const logger = require('../utils/logger');
const { reconcileStaleTransactions, listLedgerDiscrepancies } = require('../payment/payment.reconciler');

// Automated reconciliation job that runs periodically to detect and flag mismatches
const reconcileTransactionCheckpoints = async ({
  prisma,
  horizonServer,
  staleAgeMs = 5 * 60 * 1000,
  maxTransactions = 100,
} = {}) => {
  try {
    logger.info('Starting transaction reconciliation job');

    // 1. Reconcile stale transactions against Horizon
    const txResult = await reconcileStaleTransactions({
      prisma,
      staleAgeMs,
      maxTransactions,
      horizonServer,
    });

    logger.info(`Transaction reconciliation processed ${txResult.processedCount}, updated ${txResult.updatedCount}`);

    // 2. Check for ledger-database mismatches
    const ledgerResult = await listLedgerDiscrepancies({
      prisma,
      maxEntries: 1000,
    });

    logger.info(`Ledger discrepancies found: ${ledgerResult.discrepancyCount} in ${ledgerResult.checkedCount} entries`);

    // 3. Create reconciliation checkpoints for detected mismatches
    if (ledgerResult.discrepancies.length > 0) {
      const checkpoints = [];
      for (const discrepancy of ledgerResult.discrepancies) {
        try {
          const checkpoint = await prisma.reconciliationCheckpoint.create({
            data: {
              transactionId: discrepancy.transactionId,
              checkpointType: 'ledger_database',
              status: 'mismatch',
              mismatchDetails: {
                type: discrepancy.type,
                asset: discrepancy.asset,
                detectedAt: new Date().toISOString(),
              },
              evidence: {
                journalEntryId: discrepancy.journalEntryId,
              },
            },
          });
          checkpoints.push(checkpoint);
        } catch (err) {
          logger.warn(`Failed to create checkpoint for discrepancy: ${err.message}`);
        }
      }

      logger.info(`Created ${checkpoints.length} reconciliation checkpoints for review`);
    }

    return {
      success: true,
      processedTransactions: txResult.processedCount,
      updatedTransactions: txResult.updatedCount,
      discrepanciesFound: ledgerResult.discrepancyCount,
      checkpointsCreated: ledgerResult.discrepancies.length,
    };
  } catch (err) {
    logger.error('Error in transaction reconciliation job', err.message);
    return {
      success: false,
      error: err.message,
    };
  }
};

// Manual reconciliation trigger with operator review
const manualReconciliationReview = async ({
  prisma,
  checkpointId,
  resolution,
  reason,
  adminId,
} = {}) => {
  try {
    if (!['accept_wallet', 'accept_ledger', 'accept_database', 'manual_review'].includes(resolution)) {
      throw new Error('Invalid resolution action');
    }

    const checkpoint = await prisma.reconciliationCheckpoint.findUnique({
      where: { id: checkpointId },
      include: { transaction: true },
    });

    if (!checkpoint) {
      throw new Error('Checkpoint not found');
    }

    if (checkpoint.status !== 'mismatch') {
      throw new Error('Only checkpoints with mismatch status can be resolved');
    }

    const resolved = await prisma.$transaction(async (tx) => {
      // Update checkpoint with resolution
      const updated = await tx.reconciliationCheckpoint.update({
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

      // Create audit log
      await tx.auditLog.create({
        data: {
          actorType: 'administrator',
          actorId: adminId,
          action: 'reconciliation.resolve_checkpoint',
          entityType: 'ReconciliationCheckpoint',
          entityId: checkpointId,
          metadata: {
            transactionId: checkpoint.transactionId,
            resolution,
            reason,
          },
        },
      });

      return updated;
    });

    logger.info(`Reconciliation checkpoint ${checkpointId} resolved by ${adminId} with action: ${resolution}`);
    return { success: true, data: resolved };
  } catch (err) {
    logger.error('Error resolving reconciliation checkpoint', err.message);
    return { success: false, error: err.message };
  }
};

// Observability - list pending reconciliation work
const getPendingReconciliationWork = async ({ prisma, limit = 100 } = {}) => {
  try {
    const pendingCheckpoints = await prisma.reconciliationCheckpoint.findMany({
      where: { status: { in: ['pending', 'mismatch'] } },
      take: limit,
      orderBy: { createdAt: 'asc' },
      include: {
        transaction: {
          select: {
            id: true,
            amount: true,
            status: true,
            user: { select: { phoneNumber: true } },
          },
        },
      },
    });

    return {
      pendingCount: pendingCheckpoints.length,
      checkpoints: pendingCheckpoints,
    };
  } catch (err) {
    logger.error('Error fetching pending reconciliation work', err.message);
    throw err;
  }
};

module.exports = {
  reconcileTransactionCheckpoints,
  manualReconciliationReview,
  getPendingReconciliationWork,
};
