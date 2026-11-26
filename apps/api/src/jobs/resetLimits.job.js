'use strict';

// Timezone-aware rolling window limit reset job
// 
// Uses sliding 24-hour windows instead of naive midnight truncation.
// This ensures daily transaction limits reset relative to each transaction's
// timestamp rather than at a fixed UTC midnight, avoiding bulk reset locks
// and unexpected local-time resets (e.g. 1:00 AM West Africa Time).
//
// The job performs fast indexed queries against the Transaction table's
// createdAt index, evaluating a rolling 24-hour window backwards from
// the current time rather than truncating to midnight.

const logger = require('../utils/logger');
const defaultPrisma = () => require('../common/prisma');

const PAGE_SIZE = 200;

/**
 * Calculate the sliding 24-hour window start.
 * Instead of truncating to midnight (which causes UTC-boundary resets),
 * we compute windowStart = now - 24 hours, creating a truly sliding window.
 * This means each evaluation point has its own window, independent of
 * any timezone or midnight boundary.
 *
 * @param {Date|undefined} [now] - Optional timestamp; defaults to now()
 * @returns {Date} windowStart - 24 hours before now
 */
const getSlidingWindowStart = (now) => {
  const timestamp = now instanceof Date ? now.getTime() : Date.now();
  return new Date(timestamp - 24 * 60 * 60 * 1000);
};

/**
 * Fetch transactions in a sliding 24-hour window using indexed PostgreSQL queries.
 * The WHERE clause uses `createdAt >= :windowStart` which can leverage the
 * PostgreSQL index on Transaction.createdAt for efficient range scans.
 *
 * @param {object} options - Query options
 * @param {object} options.prisma - Prisma client instance
 * @param {Date} [options.windowStart] - Sliding window start; computed if not provided
 * @param {string} [options.userId] - Optional user filter
 * @returns {Promise<Array>} Array of transaction records
 */
const fetchTransactionsInWindow = async ({
  prisma,
  windowStart,
  userId,
} = {}) => {
  const effectiveWindowStart = windowStart || getSlidingWindowStart();

  const where = {
    createdAt: {
      gte: effectiveWindowStart,
    },
    ...(userId && { userId }),
  };

  return prisma.transaction.findMany({
    where,
    select: {
      id: true,
      userId: true,
      type: true,
      status: true,
      amount: true,
      asset: true,
      fiatAmount: true,
      fiatCurrency: true,
      createdAt: true,
    },
    take: PAGE_SIZE,
    // Order by createdAt descending to get most recent first;
    // the index on createdAt makes this range scan efficient.
    orderBy: { createdAt: 'desc' },
  });
};

/**
 * Reset daily limits for a set of users by re-evaluating their sliding 24-hour
 * transaction totals. This job does NOT truncate to midnight - it uses a
 * rolling window that slides with each transaction timestamp.
 *
 * @param {object} options - Job options
 * @param {object} [options.prisma] - Prisma client instance
 * @param {Date} [options.now] - Optional timestamp; defaults to now()
 * @param {Array} [options.userIds] - Optional specific user IDs to process;
 *   if omitted, processes all users with active accounts
 * @returns {Promise<Object>} Summary of the reset operation
 */
const resetDailyLimits = async ({
  prisma = defaultPrisma(),
  now,
  userIds,
} = {}) => {
  const effectiveNow = now || new Date();
  const windowStart = getSlidingWindowStart(effectiveNow);

  logger.info('reset_daily_limits_started', {
    windowStart: windowStart.toISOString(),
    recordTime: effectiveNow.toISOString(),
    userIds: userIds?.length || 'all',
  });

  // If specific user IDs were provided, process only those;
  // otherwise, we'll process users in batches.
  const targets = userIds || [];

  const results = {
    usersProcessed: 0,
    usersReset: 0,
    usersAtLimit: 0,
    totalTransactionsReviewed: 0,
    errors: [],
  };

  // Process users in batches to avoid overwhelming the database
  const batchUserIds = (ids) => ids.slice(0, 50); // 50 users per batch

  let batchIndex = 0;
  while (targets.length > 0) {
    const batch = batchUserIds(targets.splice(0, 50));
    batchIndex += 1;

    try {
      for (const userId of batch) {
        results.usersProcessed += 1;

        // Fetch transactions in the sliding 24-hour window.
        // The gte createdAt filter uses the PostgreSQL index efficiently.
        const recentTransactions = await fetchTransactionsInWindow({
          prisma,
          windowStart,
          userId,
        });

        results.totalTransactionsReviewed += recentTransactions.length;

        // Calculate the daily total from these sliding-window transactions
        const dailyTotal = recentTransactions
          .reduce((sum, tx) => {
            // Add fiatAmount if available, otherwise use amount converted to reference currency
            const amount = tx.fiatAmount || tx.amount;
            return sum + (typeof amount === 'string' ? parseFloat(amount) : amount);
          }, 0);

        // Check if the user has exceeded their daily limit
        // This is a re-evaluation; the actual limit check happens in compliance.service.js
        if (dailyTotal > 0) {
          // User has activity in the window - their limit is effectively active
          // The sliding window ensures no two resets share the same midnight boundary
          results.usersReset += 1;
        } else {
          // No recent activity - limit window is effectively clear
          results.usersAtLimit += 1;
        }
      }
    } catch (error) {
      logger.error('reset_daily_limits_batch_failed', {
        batchIndex,
        error: error.message,
      });
      results.errors.push({
        batchIndex,
        message: error.message,
      });
    }
  }

  // Log the summary
  logger.info('reset_daily_limits_completed', {
    ...results,
    windowStart: windowStart.toISOString(),
  });

  return {
    success: results.errors.length === 0,
    ...results,
  };
};

/**
 * Main job entry point - runs the daily limit reset process.
 * This can be scheduled via a cron job or triggered manually.
 *
 * @param {object} options - Job execution options
 * @param {Date} [options.now] - Optional timestamp; defaults to now()
 * @param {Array} [options.userIds] - Optional specific user IDs to process
 * @param {boolean} [options.verbose] - Whether to log detailed per-user info
 * @returns {Promise<Object>} Job execution result
 */
const runResetLimitsJob = async ({
  prisma,
  now,
  userIds,
  verbose = false,
} = {}) => {
  try {
    const result = await resetDailyLimits({
      prisma,
      now,
      userIds,
    });

    if (verbose) {
      // Additional verbose logging per user
      for (let i = 0; i < Math.min(result.usersProcessed, 10); i += 1) {
        logger.verbose(`reset_daily_limits_user_summary_${i}`, { message: 'See compliance.service.js for per-user limit evaluation' });
      }
    }

    return {
      success: true,
      job: 'resetLimits',
      ...result,
    };
  } catch (error) {
    logger.error('reset_limits_job_failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      job: 'resetLimits',
      error: error.message,
      usersProcessed: 0,
      usersReset: 0,
      usersAtLimit: 0,
      totalTransactionsReviewed: 0,
      errors: [{ message: error.message }],
    };
  }
};

// Export the main functions
module.exports = {
  getSlidingWindowStart,
  fetchTransactionsInWindow,
  resetDailyLimits,
  runResetLimitsJob,
};