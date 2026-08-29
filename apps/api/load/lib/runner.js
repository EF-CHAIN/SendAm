'use strict';

const { Samples } = require('./stats');

/**
 * Closed-loop load runner.
 *
 * `concurrency` virtual users each issue one request at a time and start the
 * next only when the previous finishes — the same shape as real callers
 * waiting on a reply. An open-loop generator that fires at a fixed rate
 * regardless of responses would keep piling work onto an already-saturated
 * service and measure the queue rather than the service; closed-loop lets
 * throughput fall out of the measurement instead of being an input to it.
 */

const now = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * @param {object} options
 * @param {(ctx: {iteration: number, vu: number}) => Promise<{ok: boolean, statusCode?: number, reason?: string}>} options.request
 * @param {number} options.concurrency virtual users
 * @param {number} [options.durationMs] run until this elapses
 * @param {number} [options.iterations] or run exactly this many requests
 * @param {number} [options.warmupIterations] discarded before measuring
 * @param {AbortSignal} [options.signal]
 * @param {() => void} [options.onProgress]
 */
const run = async ({
  request,
  concurrency,
  durationMs,
  iterations,
  warmupIterations = 0,
  signal,
  onProgress,
}) => {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('concurrency must be a positive integer');
  }
  if (!durationMs && !iterations) {
    throw new TypeError('one of durationMs or iterations is required');
  }

  const samples = new Samples();
  let issued = 0;
  let completed = 0;

  // Warmup runs through the same code path but its samples are thrown away, so
  // JIT warmup, connection setup and cold caches don't land in the percentiles.
  const warmup = async () => {
    for (let i = 0; i < warmupIterations; i += 1) {
      try {
        await request({ iteration: i, vu: 0, warmup: true });
      } catch {
        // A failing warmup is not a result; the measured phase will surface it.
      }
    }
  };

  await warmup();

  const startedAt = now();
  const deadline = durationMs ? startedAt + durationMs : Infinity;

  const shouldContinue = () => {
    if (signal?.aborted) return false;
    if (iterations && issued >= iterations) return false;
    if (durationMs && now() >= deadline) return false;
    return true;
  };

  const virtualUser = async (vu) => {
    while (shouldContinue()) {
      const iteration = issued;
      issued += 1;
      const requestStarted = now();
      let outcome;
      try {
        outcome = await request({ iteration, vu });
      } catch (error) {
        outcome = { ok: false, reason: error?.code || error?.name || 'exception' };
      }
      samples.record({
        latencyMs: now() - requestStarted,
        ok: Boolean(outcome?.ok),
        reason: outcome?.reason,
        statusCode: outcome?.statusCode,
      });
      completed += 1;
      onProgress?.({ completed, issued });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, vu) => virtualUser(vu)));

  const elapsedMs = now() - startedAt;
  return { ...samples.summarize(elapsedMs), elapsedMs: Math.round(elapsedMs), concurrency };
};

module.exports = { run };
