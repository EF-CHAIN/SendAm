'use strict';

/**
 * Human-readable and machine-readable run reports.
 *
 * The console form is what a maintainer reads in a PR comment; the JSON form
 * (--json) is what a future CI job would diff between runs to catch capacity
 * regressions. Both carry the same numbers.
 */

const pad = (value, width) => String(value).padEnd(width);
const fmt = (value, unit) => {
  if (value === null || value === undefined) return 'n/a';
  if (unit === 'fraction') return `${(value * 100).toFixed(3)}%`;
  if (unit === 'ms') return `${value}ms`;
  if (unit === 'rps') return `${value}/s`;
  return String(value);
};

const renderText = ({ scenario, summary, evaluation, queueLag, resources, invariant, meta }) => {
  const lines = [];
  lines.push('');
  lines.push(`Scenario:    ${scenario.name} — ${scenario.summary}`);
  lines.push(`Target:      ${meta.target}`);
  lines.push(`Load:        ${summary.concurrency} concurrent, ${summary.requests} requests in ${summary.elapsedMs}ms`);
  if (meta.note) lines.push(`Note:        ${meta.note}`);
  lines.push('');
  lines.push('  Latency      p50 ' + fmt(summary.latencyMs.p50, 'ms')
    + '   p95 ' + fmt(summary.latencyMs.p95, 'ms')
    + '   p99 ' + fmt(summary.latencyMs.p99, 'ms')
    + '   max ' + fmt(summary.latencyMs.max, 'ms'));
  lines.push('  Throughput   ' + fmt(summary.throughputRps, 'rps'));
  lines.push('  Error rate   ' + fmt(summary.errorRate, 'fraction') + ` (${summary.failed}/${summary.requests})`);

  if (queueLag?.measured) {
    lines.push('  Queue lag    depth ' + queueLag.depth + '   oldest ' + fmt(queueLag.oldestJobAgeMs, 'ms'));
  } else {
    lines.push('  Queue lag    not measured — ' + (queueLag?.reason || 'unavailable'));
  }

  if (resources?.connections?.measured) {
    const c = resources.connections;
    lines.push('  DB conns     peak ' + c.peakTotal + '/' + c.maxConnections
      + ' (' + Math.round(c.utilisation * 100) + '%)   peak active ' + c.peakActive);
  } else if (resources) {
    lines.push('  DB conns     not measured — ' + (resources.connections?.reason || 'unavailable'));
  }

  if (resources?.memory?.measured) {
    lines.push('  Memory       peak RSS ' + resources.memory.peakMb + 'MB');
  } else if (resources) {
    lines.push('  Memory       not measured — ' + (resources.memory?.reason || 'unavailable'));
  }

  const statuses = Object.entries(summary.statusCounts);
  if (statuses.length) {
    lines.push('  Statuses     ' + statuses.map(([code, count]) => `${code}:${count}`).join('  '));
  }
  const errors = Object.entries(summary.errorsByReason);
  if (errors.length) {
    lines.push('  Failures     ' + errors.map(([reason, count]) => `${reason}:${count}`).join('  '));
  }

  if (invariant) {
    lines.push('');
    lines.push(`  Invariant    ${invariant.passed ? 'HOLDS' : 'VIOLATED'} — ${invariant.name}`);
    lines.push(`               ${invariant.detail}`);
  }

  lines.push('');
  lines.push('  Budget');
  for (const check of evaluation.checks) {
    const status = check.skipped ? 'skip' : (check.passed ? 'pass' : 'FAIL');
    if (check.limit === null) {
      // A check that failed because its input was never measured; printing a
      // comparison against `n/a` would read as a threshold breach.
      lines.push(`    [${status}] ${pad(check.name, 16)} ${check.reason}`);
      continue;
    }
    const comparator = check.name === 'throughput' ? '>=' : '<=';
    lines.push(`    [${status}] ${pad(check.name, 16)} ${fmt(check.actual, check.unit)} ${comparator} ${fmt(check.limit, check.unit)}`);
  }
  lines.push('');
  lines.push(`  RESULT: ${evaluation.passed && (invariant?.passed ?? true) ? 'PASS' : 'FAIL'}`);
  lines.push('');
  return lines.join('\n');
};

module.exports = { renderText };
