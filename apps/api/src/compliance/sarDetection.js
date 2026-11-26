'use strict';

/**
 * Suspicious Activity Reporting (SAR) Automated Detection and Audit Flagging (#986).
 *
 * Implements rule-based detection for structuring / smurfing transactions:
 * 1. Transactions executed just below regulatory reporting thresholds ($9,900 / $10,000).
 * 2. Rapid multiple transfers within a rolling 7-day window aggregating above the reporting threshold.
 * 3. Automated generation of SAR draft reports in the database and compliance audit logging/alerting.
 */

const crypto = require('crypto');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const { writeAuditLog } = require('../common/audit.service');

// Standard FinCEN / AML Cash Transaction Reporting (CTR) and SAR thresholds
const REPORTING_THRESHOLD_USD = 10000.00;
const STRUCTURING_TARGET_USD = 9900.00;
const STRUCTURING_LOWER_BOUND_USD = 8000.00;
const STRUCTURING_UPPER_BOUND_USD = 9999.99;
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_WINDOW_MS = DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Detection Rule IDs
const RULES = Object.freeze({
  NEAR_THRESHOLD_STRUCTURING: 'RULE_NEAR_THRESHOLD_STRUCTURING',
  RAPID_SUB_THRESHOLD_AGGREGATE: 'RULE_RAPID_SUB_THRESHOLD_AGGREGATE',
  MULTIPLE_BURST_STRUCTURING: 'RULE_MULTIPLE_BURST_STRUCTURING',
});

/**
 * Parse monetary value to USD number.
 * USDC is 1:1 with USD. If fiatAmount and fiatCurrency === 'USD', use fiatAmount.
 */
const toUsdNumber = (tx) => {
  if (!tx) return 0;
  if (String(tx.fiatCurrency || '').toUpperCase() === 'USD' && tx.fiatAmount) {
    const parsed = Number(tx.fiatAmount);
    if (Number.isFinite(parsed)) return Math.abs(parsed);
  }
  if (tx.amount !== undefined && tx.amount !== null) {
    const parsed = Number(tx.amount);
    if (Number.isFinite(parsed)) return Math.abs(parsed);
  }
  return 0;
};

/**
 * Pure rule evaluation over an array of transactions in the window.
 *
 * @param {Object} params
 * @param {Array} params.transactions - List of user transactions
 * @param {number} [params.windowDays=7] - Evaluation window in days
 * @param {number} [params.reportingThreshold=10000] - Reporting limit
 * @param {number} [params.lowerBound=8000] - Structuring lower boundary
 * @param {number} [params.upperBound=9999.99] - Structuring upper boundary
 * @returns {Object} Detection result
 */
const detectStructuring = ({
  transactions = [],
  windowDays = DEFAULT_WINDOW_DAYS,
  reportingThreshold = REPORTING_THRESHOLD_USD,
  lowerBound = STRUCTURING_LOWER_BOUND_USD,
  upperBound = STRUCTURING_UPPER_BOUND_USD,
} = {}) => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return {
      isSuspicious: false,
      rule: null,
      reasons: [],
      suspiciousTransactions: [],
      totalAmountUsd: '0.00',
      narrative: 'No transactions found in evaluation window.',
    };
  }

  // Filter out failed or cancelled transactions
  const validTxs = transactions.filter((t) => t.status !== 'failed' && t.status !== 'cancelled');

  // Map with computed USD amounts
  const txsWithAmount = validTxs.map((t) => ({
    ...t,
    amountUsd: toUsdNumber(t),
  })).filter((t) => t.amountUsd > 0);

  // Near-threshold transactions (e.g. $8,000 - $9,999.99, specifically targeting $9,900)
  const nearThresholdTxs = txsWithAmount.filter(
    (t) => t.amountUsd >= lowerBound && t.amountUsd <= upperBound
  );

  const totalNearThresholdUsd = nearThresholdTxs.reduce((sum, t) => sum + t.amountUsd, 0);

  // Rule 1: Multiple near-threshold transactions within window (classic structuring/smurfing)
  if (nearThresholdTxs.length >= 2 || (nearThresholdTxs.length >= 1 && totalNearThresholdUsd >= reportingThreshold)) {
    const reasons = [
      `Detected ${nearThresholdTxs.length} transactions between $${lowerBound.toFixed(2)} and $${upperBound.toFixed(2)} (total: $${totalNearThresholdUsd.toFixed(2)}) within ${windowDays} days`,
      `Transactions structured just below $${reportingThreshold.toFixed(2)} reporting threshold (smurfing pattern)`,
    ];

    const narrative = `Automated SAR Detection Flag: Structuring / Smurfing identified under Rule ${RULES.NEAR_THRESHOLD_STRUCTURING}. ` +
      `User executed ${nearThresholdTxs.length} transactions totaling $${totalNearThresholdUsd.toFixed(2)} within a ${windowDays}-day window, ` +
      `each individually under the $${reportingThreshold.toFixed(2)} regulatory threshold.`;

    return {
      isSuspicious: true,
      rule: RULES.NEAR_THRESHOLD_STRUCTURING,
      reasons,
      suspiciousTransactions: nearThresholdTxs,
      totalAmountUsd: totalNearThresholdUsd.toFixed(2),
      narrative,
    };
  }

  // Rule 2: Rapid sub-threshold transactions aggregating above reporting limit
  // >= 3 transactions under threshold aggregating to >= $10,000
  const subThresholdTxs = txsWithAmount.filter((t) => t.amountUsd < reportingThreshold);
  const totalSubThresholdUsd = subThresholdTxs.reduce((sum, t) => sum + t.amountUsd, 0);

  if (subThresholdTxs.length >= 3 && totalSubThresholdUsd >= reportingThreshold) {
    const reasons = [
      `Detected ${subThresholdTxs.length} sub-threshold transactions aggregating to $${totalSubThresholdUsd.toFixed(2)} (exceeds $${reportingThreshold.toFixed(2)}) within ${windowDays} days`,
      `Rapid consecutive transfers avoid single-transaction threshold`,
    ];

    const narrative = `Automated SAR Detection Flag: Rapid Aggregate Structuring identified under Rule ${RULES.RAPID_SUB_THRESHOLD_AGGREGATE}. ` +
      `User completed ${subThresholdTxs.length} payments aggregating to $${totalSubThresholdUsd.toFixed(2)}, ` +
      `exceeding the $${reportingThreshold.toFixed(2)} threshold in ${windowDays} days while keeping individual transfers below threshold.`;

    return {
      isSuspicious: true,
      rule: RULES.RAPID_SUB_THRESHOLD_AGGREGATE,
      reasons,
      suspiciousTransactions: subThresholdTxs,
      totalAmountUsd: totalSubThresholdUsd.toFixed(2),
      narrative,
    };
  }

  // Rule 3: Clustered burst transactions within 24 hours just under threshold
  const sortedTxs = [...txsWithAmount].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  for (let i = 0; i < sortedTxs.length; i++) {
    const windowStart = new Date(sortedTxs[i].createdAt).getTime();
    const burstTxs = sortedTxs.slice(i).filter(
      (t) => (new Date(t.createdAt).getTime() - windowStart) <= 24 * 60 * 60 * 1000
    );
    const burstTotal = burstTxs.reduce((sum, t) => sum + t.amountUsd, 0);
    if (burstTxs.length >= 2 && burstTotal >= (reportingThreshold * 0.9) && burstTxs.some((t) => t.amountUsd >= lowerBound)) {
      return {
        isSuspicious: true,
        rule: RULES.MULTIPLE_BURST_STRUCTURING,
        reasons: [
          `Rapid burst: ${burstTxs.length} transfers totaling $${burstTotal.toFixed(2)} within 24 hours just below threshold`,
        ],
        suspiciousTransactions: burstTxs,
        totalAmountUsd: burstTotal.toFixed(2),
        narrative: `Automated SAR Detection Flag: 24-hour burst structuring under Rule ${RULES.MULTIPLE_BURST_STRUCTURING}. Totaling $${burstTotal.toFixed(2)}.`,
      };
    }
  }

  return {
    isSuspicious: false,
    rule: null,
    reasons: [],
    suspiciousTransactions: [],
    totalAmountUsd: '0.00',
    narrative: 'Transfer pattern within expected thresholds.',
  };
};

/**
 * Analyze transactions for a specific user over the rolling window.
 */
const analyzeUserTransfers = async ({
  userId,
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  prismaClient = prisma,
} = {}) => {
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const transactions = await prismaClient.transaction.findMany({
    where: {
      userId,
      createdAt: { gte: windowStart },
      status: { notIn: ['failed', 'cancelled'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  return detectStructuring({ transactions, windowDays });
};

/**
 * Generate a SAR draft report and dispatch compliance alert.
 */
const generateSarDraft = async ({
  userId,
  detectionResult,
  prismaClient = prisma,
} = {}) => {
  if (!detectionResult || !detectionResult.isSuspicious) {
    return { created: false, reason: 'not_suspicious' };
  }

  const transactionIds = (detectionResult.suspiciousTransactions || []).map((t) => t.id).filter(Boolean);

  // Deduplication check: Do not re-draft if a pending/draft SAR already exists with these transaction IDs
  const existingReport = await prismaClient.sarReport.findFirst({
    where: {
      userId,
      status: { in: ['draft', 'under_review'] },
      detectionRule: detectionResult.rule,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existingReport) {
    const existingIds = new Set(existingReport.transactionIds || []);
    const hasNewTransactions = transactionIds.some((id) => !existingIds.has(id));
    if (!hasNewTransactions) {
      return { created: false, duplicate: true, report: existingReport };
    }
  }

  const reportNumber = `SAR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const report = await prismaClient.sarReport.create({
    data: {
      userId,
      reportNumber,
      status: 'draft',
      reason: detectionResult.rule,
      narrative: detectionResult.narrative,
      transactionIds,
      totalAmountUsd: detectionResult.totalAmountUsd,
      detectionRule: detectionResult.rule,
      metadata: {
        reasons: detectionResult.reasons,
        evaluatedAt: new Date().toISOString(),
        transactionCount: transactionIds.length,
      },
    },
  });

  // 1. Audit Log Entry
  try {
    await writeAuditLog({
      action: 'compliance.sar.draft_created',
      entityType: 'SarReport',
      entityId: report.id,
      actorType: 'system',
      metadata: {
        userId,
        reportNumber,
        rule: detectionResult.rule,
        totalAmountUsd: detectionResult.totalAmountUsd,
        transactionIds,
      },
    });
  } catch (err) {
    logger.warn('sar_audit_log_failed', { message: err.message, reportId: report.id });
  }

  // 2. Compliance Alert Notification
  try {
    await prismaClient.notification.create({
      data: {
        userId,
        channel: 'compliance',
        type: 'COMPLIANCE_SAR_ALERT',
        recipient: 'compliance-desk@sendam.internal',
        body: `SUSPICIOUS ACTIVITY ALERT: Structuring detected for user ${userId}. Draft SAR ${reportNumber} generated ($${detectionResult.totalAmountUsd}).`,
        status: 'queued',
        referenceType: 'SarReport',
        referenceId: report.id,
      },
    });
  } catch (err) {
    logger.warn('sar_notification_alert_failed', { message: err.message, reportId: report.id });
  }

  logger.warn('compliance_sar_alert', {
    userId,
    reportId: report.id,
    reportNumber,
    rule: detectionResult.rule,
    totalAmountUsd: detectionResult.totalAmountUsd,
    transactionCount: transactionIds.length,
  });

  return { created: true, report, alertTriggered: true };
};

/**
 * End-to-end evaluation hook for a user transaction.
 */
const evaluateAndReportSar = async ({
  userId,
  transaction: _transaction,
  now = new Date(),
  prismaClient = prisma,
} = {}) => {
  try {
    const detectionResult = await analyzeUserTransfers({
      userId,
      now,
      prismaClient,
    });

    if (detectionResult.isSuspicious) {
      return await generateSarDraft({
        userId,
        detectionResult,
        prismaClient,
      });
    }

    return { created: false, isSuspicious: false };
  } catch (error) {
    logger.error('sar_evaluation_failed', { userId, message: error.message });
    return { created: false, error: error.message };
  }
};

module.exports = {
  REPORTING_THRESHOLD_USD,
  STRUCTURING_TARGET_USD,
  STRUCTURING_LOWER_BOUND_USD,
  STRUCTURING_UPPER_BOUND_USD,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_WINDOW_MS,
  RULES,
  toUsdNumber,
  detectStructuring,
  analyzeUserTransfers,
  generateSarDraft,
  evaluateAndReportSar,
};
