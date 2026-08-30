'use strict';

/**
 * Latency/throughput statistics for a load run.
 *
 * Samples are kept in full rather than streamed into an approximate digest:
 * a scenario run is bounded by wall-clock duration and one sample is a pair of
 * numbers, so even a long soak stays comfortably in memory, and exact
 * percentiles avoid arguing with the maintainer about digest error bars when a
 * run lands near a budget boundary.
 */

/**
 * Nearest-rank percentile over an ascending-sorted array.
 *
 * Nearest-rank (rather than interpolated) is deliberate: every value it
 * reports is a request that actually happened, so "p99 = 812ms" always names a
 * real observation.
 */
const percentile = (sortedAscending, fraction) => {
  if (sortedAscending.length === 0) return null;
  if (fraction <= 0) return sortedAscending[0];
  if (fraction >= 1) return sortedAscending[sortedAscending.length - 1];
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(rank, sortedAscending.length) - 1];
};

const round = (value, places = 2) => {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

class Samples {
  constructor() {
    this.latenciesMs = [];
    this.ok = 0;
    this.failed = 0;
    /** Failure reason -> count, so a report says *why* a run missed its budget. */
    this.errorsByReason = new Map();
    /** Status code -> count, including the 2xx ones. */
    this.statusCounts = new Map();
  }

  record({ latencyMs, ok, reason, statusCode }) {
    this.latenciesMs.push(latencyMs);
    if (ok) this.ok += 1;
    else {
      this.failed += 1;
      const key = reason || 'unknown';
      this.errorsByReason.set(key, (this.errorsByReason.get(key) || 0) + 1);
    }
    if (statusCode !== undefined && statusCode !== null) {
      this.statusCounts.set(statusCode, (this.statusCounts.get(statusCode) || 0) + 1);
    }
  }

  get total() {
    return this.ok + this.failed;
  }

  /**
   * @param {number} elapsedMs wall-clock duration of the run, used for throughput.
   */
  summarize(elapsedMs) {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const total = this.total;
    const elapsedSeconds = elapsedMs / 1000;
    return {
      requests: total,
      ok: this.ok,
      failed: this.failed,
      // Error *rate*, not count: budgets are expressed as a fraction so they
      // stay meaningful across runs of different length.
      errorRate: total === 0 ? 0 : round(this.failed / total, 6),
      throughputRps: elapsedSeconds === 0 ? 0 : round(total / elapsedSeconds),
      latencyMs: {
        min: round(sorted[0] ?? null),
        p50: round(percentile(sorted, 0.5)),
        p95: round(percentile(sorted, 0.95)),
        p99: round(percentile(sorted, 0.99)),
        max: round(sorted[sorted.length - 1] ?? null),
      },
      statusCounts: Object.fromEntries([...this.statusCounts].sort((a, b) => a[0] - b[0])),
      errorsByReason: Object.fromEntries([...this.errorsByReason].sort((a, b) => b[1] - a[1])),
    };
  }
}

module.exports = { Samples, percentile, round };
