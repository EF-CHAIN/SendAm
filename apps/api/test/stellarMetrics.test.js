const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderMetrics, resetMetrics } = require('../src/observability/metrics');
const {
  failureCodeFrom,
  instrumentStellarServer,
} = require('../src/observability/stellarMetrics');

beforeEach(() => resetMetrics());

const horizonError = (codes, extra = {}) => Object.assign(new Error('Transaction failed'), {
  response: { status: 400, data: { extras: { result_codes: codes } } },
  ...extra,
});

const fakeServer = ({ submit, fee = '100' } = {}) => ({
  submitTransaction: submit || (async () => ({ hash: 'abc', successful: true, fee_charged: '200' })),
  fetchBaseFee: async () => fee,
});

test('successful submission records duration, success result and fee charged', async () => {
  const server = instrumentStellarServer(fakeServer());
  const response = await server.submitTransaction({});
  assert.equal(response.hash, 'abc');

  const out = renderMetrics();
  assert.match(out, /# TYPE stellar_tx_submission_duration_seconds histogram/);
  assert.match(out, /stellar_tx_submission_duration_seconds_count 1/);
  assert.match(out, /stellar_tx_result_total\{result="success"\} 1/);
  assert.match(out, /stellar_fee_charged_stroops_total 200/);
  assert.doesNotMatch(out, /result="fail"/);
});

test('failed submission records fail result and the Horizon result code', async () => {
  const server = instrumentStellarServer(fakeServer({
    submit: async () => { throw horizonError({ transaction: 'tx_bad_auth' }); },
  }));
  await assert.rejects(() => server.submitTransaction({}), /Transaction failed/);

  const out = renderMetrics();
  assert.match(out, /stellar_tx_result_total\{result="fail"\} 1/);
  assert.match(out, /stellar_tx_failure_codes_total\{code="tx_bad_auth"\} 1/);
  assert.match(out, /stellar_tx_submission_duration_seconds_count 1/);
});

test('operation-level codes are used when the transaction code is tx_failed', () => {
  assert.equal(failureCodeFrom(horizonError({ transaction: 'tx_failed', operations: ['op_underfunded'] })), 'op_underfunded');
  assert.equal(failureCodeFrom(horizonError({ transaction: 'tx_insufficient_balance' })), 'tx_insufficient_balance');
});

test('timeouts, unknown errors and malformed codes are bucketed with bounded labels', () => {
  assert.equal(failureCodeFrom(new Error('timeout of 10000ms exceeded')), 'timeout');
  assert.equal(failureCodeFrom(new Error('boom')), 'unknown');
  assert.equal(failureCodeFrom(horizonError({ transaction: 'DROP TABLE "x"' })), 'other');
});

test('a response with successful=false counts as a failure', async () => {
  const server = instrumentStellarServer(fakeServer({
    submit: async () => ({ hash: 'abc', successful: false }),
  }));
  await server.submitTransaction({});
  assert.match(renderMetrics(), /stellar_tx_result_total\{result="fail"\} 1/);
});

test('base fee is exported as a gauge and the value is returned unchanged', async () => {
  const server = instrumentStellarServer(fakeServer({ fee: '4500' }));
  assert.equal(await server.fetchBaseFee(), '4500');
  const out = renderMetrics();
  assert.match(out, /# TYPE stellar_base_fee_stroops gauge/);
  assert.match(out, /stellar_base_fee_stroops 4500/);
});

test('instrumenting twice does not double count', async () => {
  const server = fakeServer();
  instrumentStellarServer(instrumentStellarServer(server));
  await server.submitTransaction({});
  assert.match(renderMetrics(), /stellar_tx_result_total\{result="success"\} 1/);
});

test('the shared Horizon server is instrumented', () => {
  const { server } = require('../src/config/stellar');
  assert.equal(server.__stellarMetricsInstrumented, true);
});

test('prometheus rules alert when the failure rate exceeds 2% over 5 minutes', () => {
  const rules = fs.readFileSync(path.resolve(__dirname, '../../../observability/prometheus-rules.yml'), 'utf8');
  assert.match(rules, /alert: SendAmStellarSubmissionFailureRateHigh/);
  assert.match(rules, /stellar_tx_result_total\{result="fail"\}\[5m\][\s\S]*> 0\.02/);
});
