'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  backoffCeiling,
  fullJitterDelay,
  isTransientError,
  retryAfterMs,
  computeRetryDelay,
  bullBackoffStrategy,
  retryWithBackoff,
  FULL_JITTER_BACKOFF_TYPE,
} = require('../src/queues/retryStrategy');

test('backoffCeiling follows min(max, base * 2^attempt)', () => {
  const o = { baseMs: 100, maxMs: 1000 };
  assert.deepEqual([0, 1, 2, 3, 4, 10].map((a) => backoffCeiling(a, o)), [100, 200, 400, 800, 1000, 1000]);
  assert.equal(backoffCeiling(5000, o), 1000, 'huge attempts must not overflow');
});

test('fullJitterDelay spans [0, ceiling] using the injected random source', () => {
  const o = { baseMs: 100, maxMs: 1000 };
  assert.equal(fullJitterDelay(3, { ...o, random: () => 0 }), 0);
  assert.equal(fullJitterDelay(3, { ...o, random: () => 0.5 }), 400);
  assert.ok(fullJitterDelay(3, { ...o, random: () => 0.999999 }) <= 800);
});

test('retry delays are spread across the window, not clustered', () => {
  const o = { baseMs: 1000, maxMs: 60000 };
  const samples = Array.from({ length: 500 }, () => fullJitterDelay(4, o));
  assert.ok(samples.every((d) => d >= 0 && d <= 16000));
  assert.ok(new Set(samples).size > 100, 'delays should be widely distributed');
  assert.ok(Math.min(...samples) < 4000 && Math.max(...samples) > 12000);
});

test('isTransientError flags 429/5xx/network failures but not client errors', () => {
  assert.equal(isTransientError({ response: { status: 429 } }), true);
  assert.equal(isTransientError({ response: { status: 503 } }), true);
  assert.equal(isTransientError({ status: 408 }), true);
  assert.equal(isTransientError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientError({ response: { status: 400 } }), false);
  assert.equal(isTransientError({ response: { status: 404 } }), false);
  assert.equal(isTransientError(new Error('boom')), false);
  assert.equal(isTransientError(null), false);
});

test('retryAfterMs reads seconds and HTTP dates, ignores junk', () => {
  assert.equal(retryAfterMs({ response: { headers: { 'retry-after': '3' } } }), 3000);
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = retryAfterMs({ response: { headers: { 'retry-after': future } } });
  assert.ok(ms > 2000 && ms <= 5000);
  assert.equal(retryAfterMs({ response: { headers: { 'retry-after': 'soon' } } }), null);
  assert.equal(retryAfterMs({}), null);
});

test('computeRetryDelay honours Retry-After as a floor, capped at maxMs', () => {
  const err = { response: { status: 429, headers: { 'retry-after': '10' } } };
  assert.equal(computeRetryDelay(0, err, { baseMs: 100, maxMs: 60000, random: () => 0 }), 10000);
  assert.equal(computeRetryDelay(0, err, { baseMs: 100, maxMs: 2000, random: () => 0 }), 2000);
});

test('bullBackoffStrategy only handles the full-jitter type', () => {
  assert.equal(bullBackoffStrategy(1, 'exponential', new Error('x'), {}), undefined);
  const job = { opts: { backoff: { type: FULL_JITTER_BACKOFF_TYPE, delay: 5000 } } };
  const d = bullBackoffStrategy(1, FULL_JITTER_BACKOFF_TYPE, new Error('x'), job);
  assert.ok(Number.isInteger(d) && d >= 0 && d <= 5000);
  const later = bullBackoffStrategy(4, FULL_JITTER_BACKOFF_TYPE, new Error('x'), job);
  assert.ok(later >= 0 && later <= 40000);
});

test('retryWithBackoff retries transient errors with jittered sleeps then succeeds', async () => {
  const sleeps = [];
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('rate limited'), { response: { status: 429 } });
    return 'ok';
  }, { baseMs: 100, maxMs: 1000, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result, 'ok');
  assert.deepEqual(sleeps, [50, 100]);
});

test('retryWithBackoff does not retry permanent errors and stops after the retry budget', async () => {
  let calls = 0;
  await assert.rejects(retryWithBackoff(async () => {
    calls += 1;
    throw Object.assign(new Error('bad request'), { response: { status: 400 } });
  }, { sleep: async () => {} }), /bad request/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(retryWithBackoff(async () => {
    calls += 1;
    throw Object.assign(new Error('still 429'), { response: { status: 429 } });
  }, { retries: 2, sleep: async () => {} }), /still 429/);
  assert.equal(calls, 3);
});
