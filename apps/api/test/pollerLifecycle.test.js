const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startPoller, stopPoller, isPollerRunning } = require('../src/jobs/poller');

test('Poller starts and stops cleanly using fake timers', (t) => {
  // Enable fake timers using Node's built-in mock mechanism
  t.mock.timers.enable({ apis: ['setInterval'] });

  // 1. Poller should start
  startPoller(1000);
  assert.equal(isPollerRunning(), true, 'Poller should be running');

  // 2. Fast-forward 3 seconds
  t.mock.timers.tick(3000);

  // 3. Poller should stop cleanly
  stopPoller();
  assert.equal(isPollerRunning(), false, 'Poller should be stopped');

  // 4. Ensure no stray ticks fire after shutdown
  t.mock.timers.tick(5000);
  assert.equal(isPollerRunning(), false, 'Poller remains stopped after teardown');
});