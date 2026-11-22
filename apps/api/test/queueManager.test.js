const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createQueueManager } = require('../src/queues/queueManager');

const silentLog = { info: () => {}, error: () => {}, warn: () => {} };

const makeService = ({ inFlight = 0 } = {}) => {
  const state = { inFlight, calls: [] };
  const worker = (name) => ({
    pause: async (doNotWait) => state.calls.push(`pause:${name}:${doNotWait}`),
  });
  return {
    state,
    getWorkers: () => [{ name: 'a', worker: worker('a') }, { name: 'b', worker: worker('b') }],
    getInFlightCount: () => state.inFlight,
    closeQueues: async () => state.calls.push('close'),
  };
};

test('pauses intake without waiting for active jobs, then drains and closes', async () => {
  const service = makeService({ inFlight: 2 });
  const manager = createQueueManager({ service, drainTimeoutMs: 1000, pollIntervalMs: 5, log: silentLog });
  setTimeout(() => { service.state.inFlight = 0; }, 30);
  const result = await manager.shutdown('TEST');
  assert.equal(result.drained, true);
  assert.deepEqual(service.state.calls, ['pause:a:true', 'pause:b:true', 'close']);
});

test('active jobs are not abandoned before the drain timeout elapses', async () => {
  const service = makeService({ inFlight: 1 });
  const manager = createQueueManager({ service, drainTimeoutMs: 1000, pollIntervalMs: 5, log: silentLog });
  let closedWhileActive = false;
  const originalClose = service.closeQueues;
  service.closeQueues = async () => { closedWhileActive = service.state.inFlight > 0; await originalClose(); };
  setTimeout(() => { service.state.inFlight = 0; }, 120);
  await manager.shutdown('TEST');
  assert.equal(closedWhileActive, false);
});

test('gives up after the timeout, still closes, and reports drained=false', async () => {
  const service = makeService({ inFlight: 1 });
  const errors = [];
  const manager = createQueueManager({
    service, drainTimeoutMs: 50, pollIntervalMs: 5, log: { ...silentLog, error: (event) => errors.push(event) },
  });
  const started = Date.now();
  const result = await manager.shutdown('TEST');
  assert.equal(result.drained, false);
  assert.ok(Date.now() - started >= 45);
  assert.ok(service.state.calls.includes('close'));
  assert.deepEqual(errors, ['queue_shutdown_drain_timeout']);
});

test('shutdown is idempotent across repeated signals', async () => {
  const service = makeService();
  const manager = createQueueManager({ service, drainTimeoutMs: 50, log: silentLog });
  const [first, second] = [manager.shutdown('SIGTERM'), manager.shutdown('SIGINT')];
  assert.equal(first, second);
  await first;
  assert.equal(service.state.calls.filter((call) => call === 'close').length, 1);
});

test('a worker that fails to pause does not block shutdown', async () => {
  const service = makeService();
  service.getWorkers = () => [{ name: 'bad', worker: { pause: async () => { throw new Error('boom'); } } }];
  const manager = createQueueManager({ service, drainTimeoutMs: 50, log: silentLog });
  const result = await manager.shutdown('TEST');
  assert.equal(result.drained, true);
  assert.deepEqual(service.state.calls, ['close']);
});

test('signal handlers capture SIGTERM and SIGINT, run onShutdown, then exit 0', async () => {
  const service = makeService();
  const proc = new EventEmitter();
  const manager = createQueueManager({ service, drainTimeoutMs: 50, log: silentLog });
  const order = [];
  const exited = new Promise((resolve) => {
    manager.installSignalHandlers({
      proc,
      onShutdown: async (signal) => order.push(`hook:${signal}`),
      exit: (code) => { order.push(`exit:${code}`); resolve(); },
    });
  });
  assert.equal(proc.listenerCount('SIGTERM'), 1);
  assert.equal(proc.listenerCount('SIGINT'), 1);
  proc.emit('SIGTERM');
  await exited;
  assert.deepEqual(order, ['hook:SIGTERM', 'exit:0']);
});

test('signal handlers exit 1 when shutdown fails and can be removed', async () => {
  const service = makeService();
  service.closeQueues = async () => { throw new Error('redis down'); };
  const proc = new EventEmitter();
  const manager = createQueueManager({ service, drainTimeoutMs: 50, log: silentLog });
  const exited = new Promise((resolve) => {
    manager.installSignalHandlers({ proc, exit: resolve });
  });
  proc.emit('SIGINT');
  assert.equal(await exited, 1);
  const freshProc = new EventEmitter();
  const remove = createQueueManager({ service, log: silentLog }).installSignalHandlers({ proc: freshProc, exit: () => {} });
  assert.equal(freshProc.listenerCount('SIGTERM'), 1);
  remove();
  assert.equal(freshProc.listenerCount('SIGTERM'), 0);
  assert.equal(freshProc.listenerCount('SIGINT'), 0);
});
