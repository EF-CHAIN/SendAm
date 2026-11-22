'use strict';

// Graceful shutdown lifecycle for BullMQ workers (#1008).
//
// Deploying a new version sends SIGTERM/SIGINT while workers may be midway
// through a payment. The manager:
//   1. stops queue intake (workers are paused without waiting, so no new job
//      is picked up) while active jobs keep running;
//   2. waits for in-flight jobs to finish, up to a timeout (30s by default);
//   3. closes workers, queues and Redis only afterwards.
// A job still running at the timeout is not killed mid-flight by us: the
// worker lock expires and BullMQ's stalled-job checker hands it to a resumed
// worker, which is why payment processors must stay idempotent.

const logger = require('../utils/logger');
const queueService = require('./queue.service');

const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 1000;
const POLL_INTERVAL_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createQueueManager = ({
  service = queueService,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  log = logger,
} = {}) => {
  let shutdownPromise = null;
  let intakePaused = false;

  /** Stop pulling new jobs; jobs already running continue. */
  const pauseIntake = async () => {
    if (intakePaused) return;
    intakePaused = true;
    // doNotWaitActive=true: return immediately instead of waiting for active jobs.
    await Promise.all(service.getWorkers().map(async ({ name, worker }) => {
      try {
        await worker.pause(true);
      } catch (error) {
        log.error('queue_intake_pause_failed', { queue: name, message: error.message });
      }
    }));
  };

  /** Resolve true once nothing is in flight, false if the timeout elapses first. */
  const waitForInFlight = async (timeoutMs = drainTimeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (service.getInFlightCount() > 0) {
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    return true;
  };

  const shutdown = (reason = 'shutdown') => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      log.info('queue_shutdown_started', { reason, inFlight: service.getInFlightCount() });
      await pauseIntake();
      const drained = await waitForInFlight();
      if (!drained) {
        log.error('queue_shutdown_drain_timeout', {
          reason,
          timeoutMs: drainTimeoutMs,
          inFlight: service.getInFlightCount(),
        });
      }
      await service.closeQueues();
      log.info('queue_shutdown_complete', { reason, drained });
      return { drained };
    })();
    return shutdownPromise;
  };

  /**
   * Capture SIGTERM/SIGINT. `onShutdown` runs after the queues drain, e.g. to
   * close the HTTP server and database. Returns a function removing the hooks.
   */
  const installSignalHandlers = ({
    onShutdown,
    exit = (code) => process.exit(code),
    signals = ['SIGTERM', 'SIGINT'],
    proc = process,
  } = {}) => {
    const handlers = signals.map((signal) => {
      const handler = () => {
        shutdown(signal)
          .then(async (result) => {
            if (onShutdown) await onShutdown(signal, result);
            exit(0);
          })
          .catch((error) => {
            log.error('queue_shutdown_failed', { signal, message: error.message });
            exit(1);
          });
      };
      proc.once(signal, handler);
      return [signal, handler];
    });
    return () => handlers.forEach(([signal, handler]) => proc.removeListener(signal, handler));
  };

  return { pauseIntake, waitForInFlight, shutdown, installSignalHandlers };
};

module.exports = { createQueueManager, DEFAULT_DRAIN_TIMEOUT_MS };
