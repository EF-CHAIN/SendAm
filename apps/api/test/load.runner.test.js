const { test } = require('node:test');
const assert = require('node:assert/strict');

const { run } = require('../load/lib/runner');

const ok = async () => ({ ok: true, statusCode: 200 });

test('runs exactly the requested number of iterations', async () => {
  let calls = 0;
  const summary = await run({
    request: async () => { calls += 1; return ok(); },
    concurrency: 4,
    iterations: 40,
  });
  assert.equal(calls, 40);
  assert.equal(summary.requests, 40);
  assert.equal(summary.failed, 0);
});

test('warmup requests are issued but excluded from the measurements', async () => {
  let calls = 0;
  const summary = await run({
    request: async () => { calls += 1; return ok(); },
    concurrency: 2,
    iterations: 10,
    warmupIterations: 5,
  });
  assert.equal(calls, 15, 'warmup requests are really sent');
  assert.equal(summary.requests, 10, 'but only the measured phase is counted');
});

test('keeps at most `concurrency` requests in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  await run({
    request: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return ok();
    },
    concurrency: 3,
    iterations: 30,
  });
  assert.equal(peak, 3);
});

test('a throwing request is recorded as a failure rather than aborting the run', async () => {
  const summary = await run({
    request: async ({ iteration }) => {
      if (iteration % 2 === 0) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
      return ok();
    },
    concurrency: 2,
    iterations: 10,
  });
  assert.equal(summary.requests, 10);
  assert.equal(summary.failed, 5);
  assert.equal(summary.errorRate, 0.5);
  assert.equal(summary.errorsByReason.ECONNRESET, 5);
});

test('a duration-bounded run stops on its own and reports elapsed time', async () => {
  const summary = await run({
    request: async () => { await new Promise((r) => setTimeout(r, 2)); return ok(); },
    concurrency: 2,
    durationMs: 60,
  });
  assert.ok(summary.requests > 0, 'did some work');
  assert.ok(summary.elapsedMs >= 50, `elapsed ${summary.elapsedMs}ms`);
  assert.ok(summary.elapsedMs < 2000, 'stopped near the deadline');
});

test('rejects a configuration that would never terminate', async () => {
  await assert.rejects(
    () => run({ request: ok, concurrency: 1 }),
    /durationMs or iterations/,
  );
  await assert.rejects(
    () => run({ request: ok, concurrency: 0, iterations: 1 }),
    /concurrency/,
  );
});
