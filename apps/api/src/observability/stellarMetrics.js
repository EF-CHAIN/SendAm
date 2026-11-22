'use strict';

// Prometheus metrics for Stellar transaction submission.
//
//   stellar_tx_submission_duration_seconds   histogram of Horizon submit latency
//   stellar_tx_result_total{result}          counter, result = success | fail
//   stellar_tx_failure_codes_total{code}     counter of Horizon result codes
//                                            (tx_bad_auth, tx_insufficient_balance, ...)
//   stellar_fee_charged_stroops_total        counter of fees actually charged
//   stellar_base_fee_stroops                 gauge of the latest network base fee
//
// They are recorded by wrapping the Horizon server so every submission path
// is covered without touching call sites.

const { increment, observeDuration, setGauge } = require('./metrics');

const SUBMISSION_DURATION = 'stellar_tx_submission_duration_seconds';
const RESULT_TOTAL = 'stellar_tx_result_total';
const FAILURE_CODES_TOTAL = 'stellar_tx_failure_codes_total';
const FEE_CHARGED_TOTAL = 'stellar_fee_charged_stroops_total';
const BASE_FEE = 'stellar_base_fee_stroops';

const CODE_PATTERN = /^(?:tx|op)_[a-z0-9_]{1,48}$/;

// Horizon result codes form a closed set; anything else is bucketed so a
// malformed upstream response cannot create unbounded label cardinality.
const normalizeCode = (code) => (typeof code === 'string' && CODE_PATTERN.test(code) ? code : 'other');

/**
 * Classify a failed submission into one Horizon result code. Operation-level
 * codes are preferred when the transaction code is the generic `tx_failed`.
 */
const failureCodeFrom = (error) => {
  const codes = error?.response?.data?.extras?.result_codes;
  const tx = codes?.transaction;
  const op = Array.isArray(codes?.operations) ? codes.operations.find((code) => code && code !== 'op_success') : null;
  if (tx && tx !== 'tx_failed') return normalizeCode(tx);
  if (op) return normalizeCode(op);
  if (tx) return normalizeCode(tx);
  const status = error?.response?.status;
  if (status === 504 || error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '')) return 'timeout';
  return 'unknown';
};

const recordBaseFee = (fee) => {
  const stroops = Number(fee);
  if (Number.isFinite(stroops) && stroops >= 0) setGauge(BASE_FEE, stroops);
};

const recordSubmission = ({ seconds, response, error }) => {
  observeDuration(SUBMISSION_DURATION, {}, seconds);
  if (error || response?.successful === false) {
    increment(RESULT_TOTAL, { result: 'fail' });
    increment(FAILURE_CODES_TOTAL, { code: error ? failureCodeFrom(error) : 'unknown' });
    return;
  }
  increment(RESULT_TOTAL, { result: 'success' });
  const fee = Number(response?.fee_charged);
  if (Number.isFinite(fee) && fee > 0) increment(FEE_CHARGED_TOTAL, {}, fee);
};

/**
 * Wrap `submitTransaction` and `fetchBaseFee` on a Horizon server instance.
 * Idempotent: a server is only wrapped once. Metric recording never alters
 * the result or error of the wrapped call.
 */
const instrumentStellarServer = (server) => {
  if (!server || server.__stellarMetricsInstrumented) return server;

  const submit = server.submitTransaction?.bind(server);
  if (submit) {
    server.submitTransaction = async (...args) => {
      const started = process.hrtime.bigint();
      const seconds = () => Number(process.hrtime.bigint() - started) / 1e9;
      try {
        const response = await submit(...args);
        recordSubmission({ seconds: seconds(), response });
        return response;
      } catch (error) {
        recordSubmission({ seconds: seconds(), error });
        throw error;
      }
    };
  }

  const fetchBaseFee = server.fetchBaseFee?.bind(server);
  if (fetchBaseFee) {
    server.fetchBaseFee = async (...args) => {
      const fee = await fetchBaseFee(...args);
      recordBaseFee(fee);
      return fee;
    };
  }

  Object.defineProperty(server, '__stellarMetricsInstrumented', { value: true });
  return server;
};

module.exports = {
  BASE_FEE,
  FAILURE_CODES_TOTAL,
  FEE_CHARGED_TOTAL,
  RESULT_TOTAL,
  SUBMISSION_DURATION,
  failureCodeFrom,
  instrumentStellarServer,
  recordBaseFee,
  recordSubmission,
};
