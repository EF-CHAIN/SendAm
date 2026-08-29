'use strict';

// Dependency health registry and aggregation (#316).
//
// `/health/ready` answers one question — should this instance take traffic —
// by checking Postgres and Redis together and collapsing the result to
// ok/degraded. That is the right shape for a load balancer and the wrong shape
// for an operator: when it flips to degraded it does not say which dependency
// broke, and it says nothing at all about Horizon or the WhatsApp provider,
// which can be down for hours while readiness stays green and customers get
// nothing.
//
// This module checks each dependency separately, records latency, and
// aggregates by criticality.

const config = require('../config/env');
const logger = require('../utils/logger');
const { increment, observeDuration, setGauge } = require('./metrics');

const STATUS = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown',
};

/**
 * Criticality decides what a failure means for the platform as a whole.
 *
 *   critical — customers cannot transact without it
 *   important — a customer-visible feature is broken, the platform is not
 *   optional — degraded experience only; never fails the aggregate
 */
const CRITICALITY = {
  CRITICAL: 'critical',
  IMPORTANT: 'important',
  OPTIONAL: 'optional',
};

/**
 * Run one check under a timeout.
 *
 * A hung dependency is the case that matters most and the one a bare `await`
 * handles worst: without the race, a health endpoint that exists to report a
 * hang would itself hang, and the operator learns nothing.
 */
const withTimeout = async (fn, timeoutMs, name) => {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} health check timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The dependencies we monitor.
 *
 * `degradedAboveMs` marks a dependency that answers but answers slowly. A
 * check that only reports up/down hides the most common real failure — a
 * provider that is technically reachable and too slow to be useful — until it
 * crosses into a timeout.
 */
const buildRegistry = ({ prisma, pingRedis, fetchImpl = globalThis.fetch } = {}) => [
  {
    name: 'postgres',
    criticality: CRITICALITY.CRITICAL,
    degradedAboveMs: 250,
    description: 'Primary datastore for customers, wallets, and the ledger.',
    check: () => prisma.$queryRaw`SELECT 1`,
  },
  {
    name: 'redis',
    criticality: CRITICALITY.CRITICAL,
    degradedAboveMs: 100,
    description: 'Queue backend and rate-limit store.',
    check: () => pingRedis(config.health.timeoutMs),
  },
  {
    name: 'stellar_horizon',
    criticality: CRITICALITY.CRITICAL,
    degradedAboveMs: 1500,
    description: 'Stellar ledger access for balances and submission.',
    check: async () => {
      const response = await fetchImpl(`${config.stellar.horizonUrl}/`, { method: 'GET' });
      if (!response.ok) throw new Error(`Horizon returned ${response.status}`);
    },
  },
  {
    name: 'whatsapp_provider',
    criticality: CRITICALITY.IMPORTANT,
    degradedAboveMs: 1500,
    description: 'Meta Graph API — the only channel customers reach us on.',
    check: async () => {
      const version = config.whatsapp.graphApiVersion || 'v20.0';
      const response = await fetchImpl(`https://graph.facebook.com/${version}/`, { method: 'GET' });
      // Meta answers an unauthenticated probe with 4xx. That is a reachable
      // API: treating it as a failure would page someone every minute for a
      // service that is working exactly as expected.
      if (response.status >= 500) throw new Error(`Graph API returned ${response.status}`);
    },
  },
];

/** Run one dependency's check and classify the result. */
const checkDependency = async (dependency, { timeoutMs = config.health.timeoutMs } = {}) => {
  const startedAt = Date.now();
  try {
    await withTimeout(dependency.check, timeoutMs, dependency.name);
    const latencyMs = Date.now() - startedAt;
    const slow = dependency.degradedAboveMs != null && latencyMs > dependency.degradedAboveMs;
    const status = slow ? STATUS.DEGRADED : STATUS.HEALTHY;

    observeDuration('sendam_dependency_check_duration_seconds', { dependency: dependency.name }, latencyMs / 1000);
    increment('sendam_dependency_checks_total', { dependency: dependency.name, status });

    return {
      name: dependency.name,
      criticality: dependency.criticality,
      description: dependency.description,
      status,
      latencyMs,
      thresholdMs: dependency.degradedAboveMs ?? null,
      error: null,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    increment('sendam_dependency_checks_total', { dependency: dependency.name, status: STATUS.UNHEALTHY });
    return {
      name: dependency.name,
      criticality: dependency.criticality,
      description: dependency.description,
      status: STATUS.UNHEALTHY,
      latencyMs,
      thresholdMs: dependency.degradedAboveMs ?? null,
      error: error.message,
      checkedAt: new Date().toISOString(),
    };
  }
};

/**
 * Roll individual results into one platform status.
 *
 * Criticality decides the verdict, not arithmetic: one dead critical
 * dependency is an outage even when nine others are fine, and a dead optional
 * one is not an outage however many there are. Averaging would report both
 * wrong.
 */
const aggregate = (results) => {
  const critical = results.filter((r) => r.criticality === CRITICALITY.CRITICAL);
  const important = results.filter((r) => r.criticality === CRITICALITY.IMPORTANT);

  if (critical.some((r) => r.status === STATUS.UNHEALTHY)) return STATUS.UNHEALTHY;
  if (important.some((r) => r.status === STATUS.UNHEALTHY)) return STATUS.DEGRADED;
  if (results.some((r) => r.status === STATUS.DEGRADED)) return STATUS.DEGRADED;
  return STATUS.HEALTHY;
};

/**
 * Alert on anything not healthy.
 *
 * Emitted as a structured log plus a counter rather than a direct page: the
 * alerting rules belong in the alert manager, where they can be tuned without
 * a deploy, and where a flapping dependency can be suppressed without editing
 * the health check that detects it.
 */
const raiseAlerts = (results) => {
  for (const result of results) {
    if (result.status === STATUS.HEALTHY) continue;
    increment('sendam_dependency_alerts_total', {
      dependency: result.name,
      status: result.status,
      criticality: result.criticality,
    });
    const log = result.criticality === CRITICALITY.CRITICAL ? logger.error : logger.warn;
    log('dependency_unhealthy', {
      dependency: result.name,
      status: result.status,
      criticality: result.criticality,
      latencyMs: result.latencyMs,
      error: result.error,
    });
  }
};

/**
 * Check every dependency and return the dashboard payload.
 *
 * Checks run in parallel — serially, the endpoint's own latency would be the
 * sum of every timeout, so one hung dependency would make the dashboard look
 * broken too.
 */
const checkAll = async (options = {}) => {
  const registry = options.registry || buildRegistry({
    prisma: options.prisma || require('../common/prisma'),
    pingRedis: options.pingRedis || require('../queues/queue.service').pingRedis,
    fetchImpl: options.fetchImpl,
  });

  const startedAt = Date.now();
  const dependencies = await Promise.all(
    registry.map((dependency) => checkDependency(dependency, options)),
  );

  const status = aggregate(dependencies);

  // A gauge per dependency, so an alert rule can fire on the dependency being
  // down rather than on the absence of a log line.
  for (const dependency of dependencies) {
    setGauge('sendam_dependency_up', dependency.status === STATUS.UNHEALTHY ? 0 : 1, {
      dependency: dependency.name,
      criticality: dependency.criticality,
    });
  }

  if (status !== STATUS.HEALTHY) raiseAlerts(dependencies);

  return {
    status,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    uptime: process.uptime(),
    summary: {
      healthy: dependencies.filter((d) => d.status === STATUS.HEALTHY).length,
      degraded: dependencies.filter((d) => d.status === STATUS.DEGRADED).length,
      unhealthy: dependencies.filter((d) => d.status === STATUS.UNHEALTHY).length,
    },
    dependencies,
  };
};

/**
 * HTTP status for an aggregate.
 *
 * Degraded stays 200: the instance can still serve, and returning 503 would
 * make a load balancer pull a node that is merely slow — turning a partial
 * degradation into a full outage.
 */
const httpStatusFor = (status) => (status === STATUS.UNHEALTHY ? 503 : 200);

module.exports = {
  STATUS,
  CRITICALITY,
  withTimeout,
  buildRegistry,
  checkDependency,
  aggregate,
  raiseAlerts,
  checkAll,
  httpStatusFor,
};
