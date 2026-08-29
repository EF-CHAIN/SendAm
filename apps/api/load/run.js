#!/usr/bin/env node
'use strict';

const { parseArgs, usage, UsageError } = require('./lib/cli');
const { resolveTarget, TargetRefused } = require('./lib/target');
const { byName } = require('./scenarios');
const { run } = require('./lib/runner');
const { evaluate } = require('./lib/budgets');
const { sampleQueueLag } = require('./lib/queueLag');
const { ResourceSampler } = require('./lib/resources');
const { Seeder } = require('./lib/seed');
const { renderText } = require('./lib/report');

/**
 * Entry point for `npm run load`.
 *
 * Exits non-zero when any scenario breaches its budget or violates its
 * invariant, so this is usable as a gate in a scheduled capacity job rather
 * than only as something a human reads.
 */
const main = async (argv) => {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const { url, isLocal } = resolveTarget({ target: options.target });
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const adminToken = process.env.LOAD_ADMIN_TOKEN;
  const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;
  const databaseUrl = process.env.DATABASE_URL;
  const metricsToken = process.env.LOAD_METRICS_TOKEN || process.env.METRICS_TOKEN;
  const pinPepper = process.env.PIN_PEPPER || process.env.JWT_SECRET || 'development-only-pin-pepper';

  if (!options.json) {
    process.stdout.write(`\nSendAm load harness → ${url.origin}${isLocal ? ' (local)' : ' (REMOTE)'}\n`);
    if (!appSecret) {
      process.stdout.write(
        '  WHATSAPP_APP_SECRET is unset: webhook payloads are sent unsigned, which the\n'
        + '  service only accepts outside production. Numbers exclude signature verification.\n',
      );
    }
  }

  const results = [];
  let allPassed = true;

  // Scenarios that move money need real accounts; seeding once up front keeps
  // account creation out of the measured path.
  const needsSeed = options.scenarios.some((name) => byName.get(name).requires?.includes('seed'));
  const seeder = new Seeder({ databaseUrl, pinPepper });
  let seededUsers = [];
  if (needsSeed && seeder.available) {
    seededUsers = await seeder.seedUsers(Math.max(options.concurrency, 10));
    if (!options.json) {
      process.stdout.write(`  Seeded ${seededUsers.length} synthetic accounts (removed on exit).\n`);
    }
  }

  try {
    for (const name of options.scenarios) {
      const scenario = byName.get(name);

      let built;
      try {
        built = scenario.build({ url, appSecret, adminToken, seededUsers });
      } catch (error) {
        // A scenario that cannot measure what it claims to must not be
        // reported as a pass. Fail the run and say exactly what is missing.
        allPassed = false;
        results.push({ scenario: name, skipped: true, passed: false, reason: error.message });
        if (!options.json) {
          process.stdout.write(`\nScenario:    ${name}\n  CANNOT RUN: ${error.message}\n  RESULT: FAIL\n`);
        }
        continue;
      }

      const sampler = new ResourceSampler({
        metricsUrl: new URL('/metrics', url),
        metricsToken,
        databaseUrl,
      });
      await sampler.start();

      const summary = await run({
        request: built.request,
        concurrency: options.concurrency,
        durationMs: options.durationMs,
        iterations: options.iterations,
        warmupIterations: options.warmupIterations,
      });

      // Sample the queue before stopping the sampler: depth right after the
      // load stops is the backlog the run actually created.
      const queueLag = await sampleQueueLag({ redisUrl });
      await sampler.stop();
      const resources = sampler.report();

      const invariant = built.invariant?.();
      const evaluation = evaluate(name, summary, queueLag, resources);
      const passed = evaluation.passed && (invariant?.passed ?? true);
      if (!passed) allPassed = false;

      results.push({ scenario: name, summary, evaluation, queueLag, resources, invariant, passed });

      if (!options.json) {
        process.stdout.write(renderText({
          scenario,
          summary,
          evaluation,
          queueLag,
          resources,
          invariant,
          meta: { target: url.origin, note: built.note },
        }));
      }
    }
  } finally {
    await seeder.cleanup().catch(() => {});
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      target: url.origin,
      startedAt: new Date().toISOString(),
      concurrency: options.concurrency,
      passed: allPassed,
      results,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`Overall: ${allPassed ? 'PASS' : 'FAIL'}\n\n`);
  }

  return allPassed ? 0 : 1;
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      if (error instanceof UsageError || error instanceof TargetRefused) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`Load run failed: ${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main };
