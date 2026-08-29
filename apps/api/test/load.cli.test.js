const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, usage, DEFAULTS, UsageError } = require('../load/lib/cli');
const { SCENARIOS } = require('../load/scenarios');

test('with no arguments it runs every scenario at the documented defaults', () => {
  const options = parseArgs([]);
  assert.deepEqual(options.scenarios, SCENARIOS.map((s) => s.name));
  assert.equal(options.concurrency, DEFAULTS.concurrency);
  assert.equal(options.durationMs, DEFAULTS.durationMs);
});

test('--scenario is repeatable and preserves order', () => {
  const options = parseArgs(['--scenario', 'health-read', '-s', 'webhook-burst']);
  assert.deepEqual(options.scenarios, ['health-read', 'webhook-burst']);
});

test('--duration is given in seconds and stored in milliseconds', () => {
  assert.equal(parseArgs(['--duration', '30']).durationMs, 30000);
});

test('--iterations pins the request count and clears the duration', () => {
  // Leaving both set would let whichever limit hit first decide the run,
  // which is exactly the non-reproducibility the harness is meant to avoid.
  const options = parseArgs(['--iterations', '500']);
  assert.equal(options.iterations, 500);
  assert.equal(options.durationMs, undefined);
});

test('an unknown scenario is rejected and the message lists the valid ones', () => {
  assert.throws(
    () => parseArgs(['--scenario', 'not-a-scenario']),
    (error) => error instanceof UsageError
      && /not-a-scenario/.test(error.message)
      && /webhook-burst/.test(error.message),
  );
});

test('non-numeric and zero values are rejected rather than silently coerced', () => {
  assert.throws(() => parseArgs(['--concurrency', 'lots']), /positive integer/);
  assert.throws(() => parseArgs(['--concurrency', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--duration', '-5']), /positive integer/);
});

test('a flag missing its value is rejected rather than consuming the next flag', () => {
  assert.throws(() => parseArgs(['--target']), /requires a value/);
});

test('an unknown flag is rejected', () => {
  assert.throws(() => parseArgs(['--turbo']), /Unknown argument/);
});

test('usage documents every scenario and both safety opt-ins', () => {
  const text = usage();
  for (const scenario of SCENARIOS) assert.ok(text.includes(scenario.name), scenario.name);
  assert.ok(text.includes('LOAD_ALLOW_REMOTE'));
  assert.ok(text.includes('LOAD_ALLOW_PRODUCTION'));
});
