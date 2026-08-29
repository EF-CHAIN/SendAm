'use strict';

const { byName, SCENARIOS } = require('../scenarios');

/**
 * Argument parsing for the load CLI, separated from the entry point so the
 * defaults and validation are testable without spawning a process.
 */

const DEFAULTS = {
  concurrency: 20,
  durationMs: 10000,
  warmupIterations: 20,
};

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const positiveInt = (raw, flag) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`${flag} must be a positive integer, got "${raw}".`);
  }
  return value;
};

const parseArgs = (argv) => {
  const options = { ...DEFAULTS, scenarios: [], json: false, target: undefined, iterations: undefined };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value.`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--scenario': case '-s': options.scenarios.push(next()); break;
      case '--concurrency': case '-c': options.concurrency = positiveInt(next(), '--concurrency'); break;
      case '--duration': options.durationMs = positiveInt(next(), '--duration') * 1000; break;
      case '--iterations': case '-n': options.iterations = positiveInt(next(), '--iterations'); break;
      case '--warmup': options.warmupIterations = positiveInt(next(), '--warmup'); break;
      case '--target': case '-t': options.target = next(); break;
      case '--json': options.json = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        throw new UsageError(`Unknown argument "${arg}". Run with --help for usage.`);
    }
  }

  // --iterations pins the request count; leaving durationMs set as well would
  // make whichever limit hit first decide the run, which is not reproducible.
  if (options.iterations) options.durationMs = undefined;

  if (options.scenarios.length === 0) {
    options.scenarios = SCENARIOS.map((s) => s.name);
  }

  const unknown = options.scenarios.filter((name) => !byName.has(name));
  if (unknown.length) {
    throw new UsageError(
      `Unknown scenario(s): ${unknown.join(', ')}. Available: ${[...byName.keys()].join(', ')}.`,
    );
  }

  return options;
};

const usage = () => `
SendAm load harness — repeatable capacity tests for payment-critical paths.

Usage:
  npm run load --workspace=apps/api -- [options]

Options:
  -s, --scenario <name>   Scenario to run; repeatable. Default: all.
  -c, --concurrency <n>   Virtual users issuing requests. Default: ${DEFAULTS.concurrency}.
      --duration <sec>    Measured run length. Default: ${DEFAULTS.durationMs / 1000}s.
  -n, --iterations <n>    Fixed request count instead of a duration.
      --warmup <n>        Discarded warmup requests. Default: ${DEFAULTS.warmupIterations}.
  -t, --target <url>      Base URL. Default: http://127.0.0.1:3002 (or LOAD_TARGET).
      --json              Emit machine-readable JSON instead of a report.
  -h, --help              Show this message.

Scenarios:
${SCENARIOS.map((s) => `  ${s.name.padEnd(18)} ${s.summary}`).join('\n')}

Safety:
  Targets localhost by default. A non-local host requires LOAD_ALLOW_REMOTE=true,
  and NODE_ENV=production requires LOAD_ALLOW_PRODUCTION=true. See
  docs/LOAD-TESTING.md for budgets, capacity limits and scaling signals.

Environment:
  LOAD_TARGET          Base URL, same as --target.
  LOAD_ADMIN_TOKEN     Bearer token; required by admin-read.
  WHATSAPP_APP_SECRET  Signs webhook payloads so the real signature path runs.
  REDIS_URL            Queue depth / oldest-job-age sampling; required by the
                       queue-backed scenarios.
  DATABASE_URL         Seeds accounts for the money-movement scenarios and
                       samples database connection use.
  PIN_PEPPER           Must match the API's, so seeded PINs verify.
  LOAD_METRICS_TOKEN   Bearer token for /metrics, enabling memory sampling.

A scenario that cannot measure its subject fails the run rather than reporting
a pass on a path it never exercised.
`.trim();

module.exports = { parseArgs, usage, DEFAULTS, UsageError };
