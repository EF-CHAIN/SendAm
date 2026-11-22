const { server: defaultServer, StellarSdk } = require('../config/stellar');
const config = require('../config/env');
const logger = require('../utils/logger');

const DEFAULT_STALLED_LEDGER_THRESHOLD = 3;
const DEFAULT_STALLED_TIMEOUT_MS = 15_000; // ~3 ledgers at ~5s/ledger
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_FEE_MULTIPLIER = 2.0;
const DEFAULT_MAX_BUMP_ATTEMPTS = 3;
const DEFAULT_MAX_FEE_CAP_STROOPS = 1_000_000; // 0.1 XLM max fee cap
const DEFAULT_MIN_BUMP_STEP_STROOPS = 100;
const DEFAULT_BASE_FEE_STROOPS = 100;

class FeeBumpExhaustedError extends Error {
  constructor(message, { innerHash, lastFeeBumpHash = null, bumpCount = 0, lastFeeStroops = null } = {}) {
    super(message);
    this.name = 'FeeBumpExhaustedError';
    this.code = 'FEE_BUMP_EXHAUSTED';
    this.isFeeBumpExhausted = true;
    this.innerHash = innerHash;
    this.lastFeeBumpHash = lastFeeBumpHash;
    this.bumpCount = bumpCount;
    this.lastFeeStroops = lastFeeStroops;
  }
}

class FeeBumpCapExceededError extends Error {
  constructor(message, { currentFeeStroops, maxFeeCapStroops } = {}) {
    super(message);
    this.name = 'FeeBumpCapExceededError';
    this.code = 'FEE_BUMP_CAP_EXCEEDED';
    this.isFeeBumpCapExceeded = true;
    this.currentFeeStroops = currentFeeStroops;
    this.maxFeeCapStroops = maxFeeCapStroops;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (typeof timer.unref === 'function') timer.unref();
});

const getDefaultNetworkPassphrase = () => (
  config.stellar?.networkPassphrase
  || (config.stellar?.network === 'mainnet' || config.stellar?.network === 'public'
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET)
);

const getTxResultCode = (error) => error?.response?.data?.extras?.result_codes?.transaction || null;

const isInsufficientFeeError = (error) => {
  const code = getTxResultCode(error);
  if (code === 'tx_insufficient_fee' || code === 'tx_fee_bump_inner_failed') return code === 'tx_insufficient_fee';
  return typeof error?.message === 'string' && /tx_insufficient_fee/i.test(error.message);
};

const isBadSequenceError = (error) => {
  const code = getTxResultCode(error);
  if (code === 'tx_bad_seq') return true;
  return typeof error?.message === 'string' && /tx_bad_seq/i.test(error.message);
};

const isTimeoutOrCongestionError = (error) => {
  if (!error) return false;
  if (error.isHorizonWriteUncertain || error.isHorizonTimeout) return true;
  const status = error.response?.status;
  if (status === 504 || status === 429 || status === 503) return true;
  const code = error.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
  return typeof error.message === 'string' && /timeout|504|rate limit|congestion/i.test(error.message);
};

const isNotFoundError = (error) => (
  error?.response?.status === 404
  || error?.name === 'NotFoundError'
  || (typeof error?.message === 'string' && /not found|404/i.test(error.message))
);

/**
 * Unwraps a FeeBumpTransaction to its inner Transaction (SEP-0015 prohibits nested fee bumps).
 */
const unwrapInnerTransaction = (transaction) => {
  if (!transaction) {
    throw new Error('A Stellar Transaction or FeeBumpTransaction is required.');
  }
  if (transaction instanceof StellarSdk.FeeBumpTransaction || transaction.innerTransaction) {
    return transaction.innerTransaction;
  }
  return transaction;
};

/**
 * Computes the next boosted fee in stroops for a SEP-0015 FeeBumpTransaction.
 * Guarantees the new fee strictly exceeds the previous bid and respects `maxFeeCapStroops`.
 */
const computeBoostedFee = ({
  previousFeeStroops,
  recommendedBaseFeeStroops = DEFAULT_BASE_FEE_STROOPS,
  operationCount = 1,
  feeMultiplier = DEFAULT_FEE_MULTIPLIER,
  minBumpStepStroops = DEFAULT_MIN_BUMP_STEP_STROOPS,
  maxFeeCapStroops = DEFAULT_MAX_FEE_CAP_STROOPS,
}) => {
  const prev = Math.max(Number(previousFeeStroops) || DEFAULT_BASE_FEE_STROOPS, DEFAULT_BASE_FEE_STROOPS);
  const recBase = Math.max(Number(recommendedBaseFeeStroops) || DEFAULT_BASE_FEE_STROOPS, DEFAULT_BASE_FEE_STROOPS);
  const ops = Math.max(Number(operationCount) || 1, 1);
  const multiplier = Math.max(Number(feeMultiplier) || DEFAULT_FEE_MULTIPLIER, 1.1);
  const step = Math.max(Number(minBumpStepStroops) || DEFAULT_MIN_BUMP_STEP_STROOPS, 1);
  const cap = Number(maxFeeCapStroops) || DEFAULT_MAX_FEE_CAP_STROOPS;

  if (prev >= cap) {
    throw new FeeBumpCapExceededError(
      `Current fee (${prev} stroops) already reached or exceeded maxFeeCapStroops (${cap} stroops).`,
      { currentFeeStroops: prev, maxFeeCapStroops: cap },
    );
  }

  // SEP-0015 requires fee-bump max fee to cover (innerOpCount + 1) base fees.
  const sep15NetworkMinimum = Math.ceil(recBase * (ops + 1) * multiplier);
  const scaledPrevious = Math.ceil(prev * multiplier);
  const minimumIncrement = prev + step;

  const candidate = Math.max(sep15NetworkMinimum, scaledPrevious, minimumIncrement);
  return Math.min(candidate, cap);
};

/**
 * Wraps an inner Stellar transaction in a SEP-0015 FeeBumpTransaction and signs it
 * with the fee source keypair.
 */
const buildFeeBumpEnvelope = ({
  innerTransaction,
  feeSourceKeypair,
  feeSourcePublicKey = null,
  maxFeeStroops,
  networkPassphrase = getDefaultNetworkPassphrase(),
}) => {
  const innerTx = unwrapInnerTransaction(innerTransaction);
  const feeSource = feeSourcePublicKey || feeSourceKeypair?.publicKey();
  if (!feeSource) {
    throw new Error('feeSourceKeypair or feeSourcePublicKey is required to build a FeeBumpTransaction.');
  }

  const opsCount = Array.isArray(innerTx.operations) ? innerTx.operations.length : 1;
  // TransactionBuilder.buildFeeBumpTransaction expects a per-operation base fee and
  // computes total max fee as `baseFee * (innerTx.operations.length + 1)`.
  const perOpBaseFee = Math.max(
    DEFAULT_BASE_FEE_STROOPS,
    Math.floor(Number(maxFeeStroops) / (opsCount + 1)),
  );
  const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    String(perOpBaseFee),
    innerTx,
    networkPassphrase,
  );

  if (feeSourceKeypair) {
    feeBumpTx.sign(feeSourceKeypair);
  }

  return feeBumpTx;
};

/**
 * Fetches a congestion-aware recommended per-operation base fee from Horizon.
 */
const fetchRecommendedBaseFee = async (server, fallbackStroops = DEFAULT_BASE_FEE_STROOPS) => {
  if (typeof server?.feeStats === 'function') {
    try {
      const stats = await server.feeStats();
      const candidates = [
        Number(stats?.fee_charged?.p90),
        Number(stats?.max_fee?.p80),
        Number(stats?.last_ledger_base_fee),
      ].filter((v) => Number.isFinite(v) && v > 0);
      if (candidates.length > 0) {
        return Math.max(...candidates);
      }
    } catch (_err) {
      // Fall through to fetchBaseFee.
    }
  }

  if (typeof server?.fetchBaseFee === 'function') {
    try {
      const fee = Number(await server.fetchBaseFee());
      if (Number.isFinite(fee) && fee > 0) return fee;
    } catch (_err) {
      // Fall through to fallback.
    }
  }

  return fallbackStroops;
};

/**
 * Queries Horizon for the latest closed ledger sequence number.
 */
const fetchLatestLedgerSequence = async (server) => {
  if (typeof server?.ledgers !== 'function') return null;
  try {
    const res = await server.ledgers().order('desc').limit(1).call();
    const seq = Number(res?.records?.[0]?.sequence);
    return Number.isFinite(seq) ? seq : null;
  } catch (_err) {
    return null;
  }
};

/**
 * Checks whether any of the tracked hashes (inner tx or fee-bump wrapper) has confirmed on Horizon.
 */
const checkTransactionConfirmed = async (server, hashes) => {
  if (typeof server?.transactions !== 'function') {
    return { confirmed: false };
  }

  for (const hash of hashes) {
    try {
      const builder = server.transactions();
      const lookup = typeof builder.transaction === 'function'
        ? builder.transaction(hash)
        : builder.transactionHash(hash);
      const record = await lookup.call();
      if (record) {
        if (record.successful === false) {
          return {
            confirmed: false,
            failedOnChain: true,
            hash: record.hash || hash,
            ledger: record.ledger ?? record.ledger_attr ?? null,
            record,
          };
        }
        return {
          confirmed: true,
          hash: record.hash || hash,
          ledger: record.ledger ?? record.ledger_attr ?? null,
          record,
        };
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        logger.debug('Transient error polling Horizon transaction status', {
          hash,
          error: error.message,
        });
      }
    }
  }

  return { confirmed: false };
};

class FeeBumpManager {
  constructor({
    server = defaultServer,
    networkPassphrase = getDefaultNetworkPassphrase(),
    stalledLedgerThreshold = DEFAULT_STALLED_LEDGER_THRESHOLD,
    stalledTimeoutMs = DEFAULT_STALLED_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    feeMultiplier = DEFAULT_FEE_MULTIPLIER,
    maxBumpAttempts = DEFAULT_MAX_BUMP_ATTEMPTS,
    maxFeeCapStroops = DEFAULT_MAX_FEE_CAP_STROOPS,
    minBumpStepStroops = DEFAULT_MIN_BUMP_STEP_STROOPS,
    sleep = defaultSleep,
    now = Date.now,
    onBump = null,
  } = {}) {
    this.server = server;
    this.networkPassphrase = networkPassphrase;
    this.stalledLedgerThreshold = Number(stalledLedgerThreshold);
    this.stalledTimeoutMs = Number(stalledTimeoutMs);
    this.pollIntervalMs = Number(pollIntervalMs);
    this.feeMultiplier = Number(feeMultiplier);
    this.maxBumpAttempts = Number(maxBumpAttempts);
    this.maxFeeCapStroops = Number(maxFeeCapStroops);
    this.minBumpStepStroops = Number(minBumpStepStroops);
    this.sleep = sleep;
    this.now = now;
    this.onBump = typeof onBump === 'function' ? onBump : null;
  }

  /**
   * Submits a signed inner transaction, monitors confirmation across ledgers,
   * and automatically wraps & rebroadcasts it in a SEP-0015 FeeBumpTransaction
   * if it remains unconfirmed after `stalledLedgerThreshold` ledgers (~15s) or
   * is rejected due to `tx_insufficient_fee` during network congestion.
   */
  async submitWithFeeBump({
    transaction,
    feeSourceKeypair,
    feeSourcePublicKey = null,
    networkPassphrase = this.networkPassphrase,
    stalledLedgerThreshold = this.stalledLedgerThreshold,
    stalledTimeoutMs = this.stalledTimeoutMs,
    pollIntervalMs = this.pollIntervalMs,
    feeMultiplier = this.feeMultiplier,
    maxBumpAttempts = this.maxBumpAttempts,
    maxFeeCapStroops = this.maxFeeCapStroops,
    onBump = this.onBump,
  }) {
    if (!transaction) {
      throw new Error('transaction is required for submitWithFeeBump.');
    }
    if (!feeSourceKeypair) {
      throw new Error('feeSourceKeypair is required to sign SEP-0015 fee-bump envelopes.');
    }

    const innerTx = unwrapInnerTransaction(transaction);
    const innerHash = innerTx.hash().toString('hex');
    const operationCount = Array.isArray(innerTx.operations) ? innerTx.operations.length : 1;
    const trackedHashes = new Set([innerHash]);

    let currentTx = transaction;
    let currentFeeStroops = Number(transaction.fee) || DEFAULT_BASE_FEE_STROOPS;
    let lastFeeBumpHash = transaction instanceof StellarSdk.FeeBumpTransaction
      ? transaction.hash().toString('hex')
      : null;
    if (lastFeeBumpHash) trackedHashes.add(lastFeeBumpHash);

    let bumpCount = 0;

    // Step 1: Initial broadcast.
    let needsImmediateBump = false;
    try {
      const response = await this.server.submitTransaction(currentTx);
      const confirmedHash = response?.hash || currentTx.hash().toString('hex');
      if (response && response.successful !== false && !response.pending) {
        return {
          status: 'confirmed',
          txHash: confirmedHash,
          innerHash,
          feeBumpHash: lastFeeBumpHash,
          ledger: response.ledger ?? null,
          bumpCount: 0,
          finalFeeStroops: currentFeeStroops,
          response,
        };
      }
      if (confirmedHash) trackedHashes.add(confirmedHash);
    } catch (error) {
      if (isInsufficientFeeError(error)) {
        needsImmediateBump = true;
        logger.warn('Initial transaction rejected with tx_insufficient_fee; escalating to SEP-0015 fee bump', {
          innerHash,
          initialFeeStroops: currentFeeStroops,
        });
      } else if (isBadSequenceError(error)) {
        // Double-spend protection: verify whether the inner transaction already confirmed on-chain.
        const check = await checkTransactionConfirmed(this.server, trackedHashes);
        if (check.confirmed) {
          return {
            status: 'confirmed',
            txHash: check.hash,
            innerHash,
            feeBumpHash: lastFeeBumpHash,
            ledger: check.ledger,
            bumpCount: 0,
            finalFeeStroops: currentFeeStroops,
            response: check.record,
          };
        }
        throw error;
      } else if (isTimeoutOrCongestionError(error)) {
        logger.warn('Initial transaction submission timed out under congestion; monitoring before fee bump', {
          innerHash,
          error: error.message,
        });
      } else {
        throw error;
      }
    }

    // Step 2: Monitor confirmation & perform automated fee-bumps when stalled.
    while (bumpCount <= maxBumpAttempts) {
      if (!needsImmediateBump) {
        const startLedger = await fetchLatestLedgerSequence(this.server);
        const startTime = this.now();

        while (true) {
          const check = await checkTransactionConfirmed(this.server, trackedHashes);
          if (check.confirmed) {
            return {
              status: 'confirmed',
              txHash: check.hash,
              innerHash,
              feeBumpHash: lastFeeBumpHash,
              ledger: check.ledger,
              bumpCount,
              finalFeeStroops: currentFeeStroops,
              response: check.record,
            };
          }
          if (check.failedOnChain) {
            const err = new Error(`Transaction ${check.hash} failed on-chain at ledger ${check.ledger}.`);
            err.txHash = check.hash;
            err.record = check.record;
            throw err;
          }

          const currentLedger = await fetchLatestLedgerSequence(this.server);
          const ledgersElapsed = (startLedger !== null && currentLedger !== null)
            ? currentLedger - startLedger
            : null;
          const timeElapsed = this.now() - startTime;

          const stalledByLedgers = ledgersElapsed !== null && ledgersElapsed >= stalledLedgerThreshold;
          const stalledByTime = timeElapsed >= stalledTimeoutMs;

          if (stalledByLedgers || stalledByTime) {
            break;
          }

          await this.sleep(pollIntervalMs);
        }
      }

      needsImmediateBump = false;

      if (bumpCount >= maxBumpAttempts) {
        break;
      }

      // Final on-chain check right before rebroadcasting to prevent unnecessary bumps.
      const preBumpCheck = await checkTransactionConfirmed(this.server, trackedHashes);
      if (preBumpCheck.confirmed) {
        return {
          status: 'confirmed',
          txHash: preBumpCheck.hash,
          innerHash,
          feeBumpHash: lastFeeBumpHash,
          ledger: preBumpCheck.ledger,
          bumpCount,
          finalFeeStroops: currentFeeStroops,
          response: preBumpCheck.record,
        };
      }

      const recommendedBaseFee = await fetchRecommendedBaseFee(this.server, DEFAULT_BASE_FEE_STROOPS);
      const nextFeeStroops = computeBoostedFee({
        previousFeeStroops: currentFeeStroops,
        recommendedBaseFeeStroops: recommendedBaseFee,
        operationCount,
        feeMultiplier,
        minBumpStepStroops: this.minBumpStepStroops,
        maxFeeCapStroops,
      });

      const feeBumpTx = buildFeeBumpEnvelope({
        innerTransaction: innerTx,
        feeSourceKeypair,
        feeSourcePublicKey,
        maxFeeStroops: nextFeeStroops,
        networkPassphrase,
      });

      bumpCount += 1;
      currentTx = feeBumpTx;
      currentFeeStroops = nextFeeStroops;
      lastFeeBumpHash = feeBumpTx.hash().toString('hex');
      trackedHashes.add(lastFeeBumpHash);

      logger.info('Rebroadcasting stalled transaction with SEP-0015 fee bump', {
        innerHash,
        feeBumpHash: lastFeeBumpHash,
        bumpAttempt: bumpCount,
        maxFeeStroops: nextFeeStroops,
      });

      if (onBump) {
        onBump({
          innerHash,
          feeBumpHash: lastFeeBumpHash,
          bumpAttempt: bumpCount,
          feeStroops: nextFeeStroops,
          feeBumpTransaction: feeBumpTx,
        });
      }

      try {
        const bumpResponse = await this.server.submitTransaction(feeBumpTx);
        const confirmedHash = bumpResponse?.hash || lastFeeBumpHash;
        if (bumpResponse && bumpResponse.successful !== false && !bumpResponse.pending) {
          return {
            status: 'confirmed',
            txHash: confirmedHash,
            innerHash,
            feeBumpHash: lastFeeBumpHash,
            ledger: bumpResponse.ledger ?? null,
            bumpCount,
            finalFeeStroops: currentFeeStroops,
            response: bumpResponse,
          };
        }
      } catch (error) {
        if (isBadSequenceError(error)) {
          // Inner tx or an earlier fee-bump already consumed the sequence on-chain.
          const recovered = await checkTransactionConfirmed(this.server, trackedHashes);
          if (recovered.confirmed) {
            logger.info('Recovered already-confirmed transaction during fee-bump rebroadcast (prevented double-spend)', {
              txHash: recovered.hash,
              innerHash,
              bumpCount,
            });
            return {
              status: 'confirmed',
              txHash: recovered.hash,
              innerHash,
              feeBumpHash: lastFeeBumpHash,
              ledger: recovered.ledger,
              bumpCount,
              finalFeeStroops: currentFeeStroops,
              response: recovered.record,
            };
          }
          throw error;
        }

        if (isInsufficientFeeError(error)) {
          needsImmediateBump = true;
          continue;
        }

        if (isTimeoutOrCongestionError(error)) {
          // Continue monitoring the rebroadcasted fee bump before bumping again.
          continue;
        }

        throw error;
      }
    }

    throw new FeeBumpExhaustedError(
      `Transaction ${innerHash} remained unconfirmed after ${bumpCount} fee-bump attempt(s) (final fee: ${currentFeeStroops} stroops).`,
      {
        innerHash,
        lastFeeBumpHash,
        bumpCount,
        lastFeeStroops: currentFeeStroops,
      },
    );
  }
}

const createFeeBumpManager = (options = {}) => new FeeBumpManager(options);

const submitWithFeeBump = (params, options = {}) => {
  const manager = new FeeBumpManager(options);
  return manager.submitWithFeeBump(params);
};

module.exports = {
  FeeBumpManager,
  FeeBumpExhaustedError,
  FeeBumpCapExceededError,
  createFeeBumpManager,
  submitWithFeeBump,
  buildFeeBumpEnvelope,
  computeBoostedFee,
  unwrapInnerTransaction,
  fetchRecommendedBaseFee,
  DEFAULT_STALLED_LEDGER_THRESHOLD,
  DEFAULT_STALLED_TIMEOUT_MS,
  DEFAULT_MAX_BUMP_ATTEMPTS,
  DEFAULT_MAX_FEE_CAP_STROOPS,
};
