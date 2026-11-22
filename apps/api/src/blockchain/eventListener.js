'use strict';

// Soroban Contract Event Subscription Daemon (#933).
//
// Polls Soroban RPC `getEvents` at sub-5-second intervals, filters by contract ID
// and topic pattern, parses XDR/ScVal topics and event values into native
// JavaScript objects, and dispatches matched events to a BullMQ notification queue.

const { StellarSdk } = require('../config/stellar');
const { sorobanConfig } = require('../config/soroban');
const { defaultSorobanClient } = require('./soroban.client');
const { enqueue } = require('../queues/queue.service');
const logger = require('../utils/logger');

const DEFAULT_NOTIFICATION_QUEUE = 'soroban-event-notifications';
const DEFAULT_POLL_INTERVAL_MS = 2000; // <= 5 seconds acceptance criterion

/**
 * Recursively normalize a value returned from `scValToNative` so that BigInt,
 * Buffer/Uint8Array, and Map instances serialize cleanly into JSON for BullMQ.
 *
 * @param {any} value
 * @returns {any}
 */
const normalizeNativeValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('hex');
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeNativeValue(item));
  }
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value.entries()) {
      out[String(normalizeNativeValue(k))] = normalizeNativeValue(v);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeNativeValue(v);
    }
    return out;
  }
  return value;
};

/**
 * Parse a single `xdr.ScVal` or base64-encoded XDR string into a native JavaScript value.
 *
 * @param {StellarSdk.xdr.ScVal | string | any} rawVal
 * @returns {any}
 */
const parseScValToJs = (rawVal) => {
  if (rawVal === null || rawVal === undefined) return null;

  let scVal = rawVal;
  if (typeof rawVal === 'string') {
    try {
      scVal = StellarSdk.xdr.ScVal.fromXDR(rawVal, 'base64');
    } catch (_err) {
      return rawVal;
    }
  }

  if (scVal && typeof scVal.switch === 'function') {
    try {
      const native = StellarSdk.scValToNative(scVal);
      return normalizeNativeValue(native);
    } catch (_err) {
      // Fallback for specialized ScVal arms if scValToNative throws
      try {
        const arm = scVal.switch().name;
        if (arm === 'scvSymbol') return scVal.sym().toString();
        if (arm === 'scvString') return scVal.str().toString();
        if (arm === 'scvBool') return Boolean(scVal.b());
        if (arm === 'scvVoid') return null;
      } catch (_innerErr) {
        return null;
      }
    }
  }

  return normalizeNativeValue(rawVal);
};

/**
 * Encode a topic filter segment into a base64 XDR ScVal string or wildcard (`*` / `**`).
 *
 * @param {string | StellarSdk.xdr.ScVal} segment
 * @returns {string}
 */
const encodeTopicFilterSegment = (segment) => {
  if (segment === '*' || segment === '**') return segment;
  if (segment && typeof segment.toXDR === 'function') {
    return segment.toXDR('base64');
  }
  if (typeof segment === 'string') {
    // Already base64 XDR if user passed raw XDR, otherwise encode as symbol ScVal
    try {
      return StellarSdk.xdr.ScVal.scvSymbol(segment).toXDR('base64');
    } catch (_err) {
      return StellarSdk.nativeToScVal(segment).toXDR('base64');
    }
  }
  return StellarSdk.nativeToScVal(segment).toXDR('base64');
};

/**
 * Build the `filters` array for Soroban RPC `getEvents`.
 *
 * @param {object} options
 * @param {string[]} [options.contractIds=[]] - Contract C-addresses to watch.
 * @param {Array<Array<string|StellarSdk.xdr.ScVal>>} [options.topics=[]] - Topic filter patterns.
 * @param {string} [options.type='contract'] - Event type ('contract', 'system', or undefined).
 * @returns {object[]}
 */
const buildEventFilters = ({
  contractIds = [],
  topics = [],
  type = 'contract',
} = {}) => {
  const validContractIds = contractIds.filter(Boolean);
  const encodedTopics = topics
    .filter((t) => Array.isArray(t) && t.length > 0)
    .map((topicTuple) => topicTuple.map(encodeTopicFilterSegment));

  if (validContractIds.length === 0 && encodedTopics.length === 0) {
    return type ? [{ type }] : [];
  }

  const filter = {};
  if (type) filter.type = type;
  if (validContractIds.length > 0) filter.contractIds = validContractIds;
  if (encodedTopics.length > 0) filter.topics = encodedTopics;
  return [filter];
};

/**
 * Parse a raw Soroban RPC event entry into a normalized JavaScript notification object.
 *
 * @param {object} rawEvent
 * @returns {object}
 */
const parseContractEvent = (rawEvent) => {
  let contractId = null;
  if (typeof rawEvent.contractId === 'string') {
    contractId = rawEvent.contractId;
  } else if (rawEvent.contractId && typeof rawEvent.contractId.contractId === 'function') {
    contractId = rawEvent.contractId.contractId();
  } else if (rawEvent.contractId && typeof rawEvent.contractId.toString === 'function') {
    contractId = rawEvent.contractId.toString();
  }

  const rawTopics = Array.isArray(rawEvent.topic) ? rawEvent.topic : [];
  const topics = rawTopics.map((t) => parseScValToJs(t));
  const data = parseScValToJs(rawEvent.value);

  return {
    id: rawEvent.id || `${rawEvent.ledger || 0}-${rawEvent.pagingToken || Date.now()}`,
    type: rawEvent.type || 'contract',
    ledger: Number(rawEvent.ledger || 0),
    ledgerClosedAt: rawEvent.ledgerClosedAt || null,
    contractId,
    pagingToken: rawEvent.pagingToken || rawEvent.id || null,
    txHash: rawEvent.txHash || null,
    inSuccessfulContractCall: rawEvent.inSuccessfulContractCall ?? true,
    topics,
    data,
  };
};

/**
 * Check whether a parsed event matches local contractId and topic criteria.
 *
 * @param {object} parsedEvent
 * @param {object} criteria
 * @param {string[]} [criteria.contractIds]
 * @param {Array<Array<any>>} [criteria.topics]
 * @returns {boolean}
 */
const matchesEventFilter = (parsedEvent, { contractIds = [], topics = [] } = {}) => {
  if (contractIds.length > 0) {
    if (!parsedEvent.contractId || !contractIds.includes(parsedEvent.contractId)) {
      return false;
    }
  }

  if (topics.length > 0) {
    const matchesAnyPattern = topics.some((pattern) => {
      if (!Array.isArray(pattern)) return false;
      for (let i = 0; i < pattern.length; i += 1) {
        const expected = pattern[i];
        if (expected === '**') return true;
        if (expected === '*') {
          if (i >= parsedEvent.topics.length) return false;
          continue;
        }
        const expectedDecoded = typeof expected === 'object' && expected !== null
          ? parseScValToJs(expected)
          : expected;
        if (parsedEvent.topics[i] !== expectedDecoded) {
          return false;
        }
      }
      return parsedEvent.topics.length >= pattern.length;
    });

    if (!matchesAnyPattern) return false;
  }

  return true;
};

/**
 * Create and manage a Soroban contract event subscription daemon.
 *
 * @param {object} [options]
 * @param {object} [options.rpcClient=defaultSorobanClient] - Soroban RPC client.
 * @param {string[]} [options.contractIds] - Contract IDs to subscribe to.
 * @param {Array<Array<string|any>>} [options.topics] - Topic patterns to subscribe to.
 * @param {string} [options.queueName=DEFAULT_NOTIFICATION_QUEUE] - BullMQ destination queue.
 * @param {function} [options.dispatch] - Injectable queue dispatcher `(queueName, jobName, payload, opts) => Promise`.
 * @param {number} [options.pollIntervalMs=DEFAULT_POLL_INTERVAL_MS] - Polling interval (default 2000ms, well under 5s).
 * @param {number} [options.startLedger] - Optional starting ledger sequence.
 * @param {number} [options.limit=100] - Max events per RPC page.
 */
const createSorobanEventListener = ({
  rpcClient = defaultSorobanClient,
  contractIds = Object.values(sorobanConfig.contracts || {}).filter(
    (id) => typeof id === 'string' && id.startsWith('C'),
  ),
  topics = [],
  queueName = DEFAULT_NOTIFICATION_QUEUE,
  dispatch = enqueue,
  pollIntervalMs = sorobanConfig.eventPollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
  startLedger = null,
  limit = 100,
} = {}) => {
  let cursor = null;
  let currentStartLedger = startLedger;
  let timer = null;
  let isRunning = false;
  const seenEventIds = new Set();

  const filters = buildEventFilters({ contractIds, topics });

  /**
   * Perform a single poll cycle against `rpcClient.getEvents`, parse matching
   * contract events, and dispatch each to the BullMQ notification queue.
   *
   * @returns {Promise<{ processed: number, latestLedger: number | null, events: object[] }>}
   */
  const pollOnce = async () => {
    if (!cursor && currentStartLedger == null) {
      const latest = await rpcClient.getLatestLedger();
      currentStartLedger = Number(latest?.sequence || 1);
    }

    const request = {
      filters,
      pagination: { limit },
    };

    if (cursor) {
      request.pagination.cursor = cursor;
    } else {
      request.startLedger = currentStartLedger;
    }

    const response = await rpcClient.getEvents(request);
    const rawEvents = Array.isArray(response?.events) ? response.events : [];
    const latestLedger = response?.latestLedger ? Number(response.latestLedger) : null;

    const dispatchedEvents = [];

    for (const rawEvent of rawEvents) {
      const parsed = parseContractEvent(rawEvent);

      if (parsed.pagingToken) {
        cursor = parsed.pagingToken;
      }

      if (seenEventIds.has(parsed.id)) {
        continue;
      }

      if (!matchesEventFilter(parsed, { contractIds, topics })) {
        continue;
      }

      seenEventIds.add(parsed.id);
      // Bound in-memory deduplication window
      if (seenEventIds.size > 5000) {
        const oldest = seenEventIds.values().next().value;
        seenEventIds.delete(oldest);
      }

      const jobName = parsed.topics.length > 0
        ? `soroban.${parsed.topics.map(String).join('.')}`
        : 'soroban.contract.event';

      await dispatch(queueName, jobName, parsed, {
        jobId: `soroban-evt-${parsed.id}`,
      });

      dispatchedEvents.push(parsed);
    }

    if (rawEvents.length === 0 && !cursor && latestLedger) {
      currentStartLedger = latestLedger;
    }

    return {
      processed: dispatchedEvents.length,
      latestLedger,
      events: dispatchedEvents,
    };
  };

  /**
   * Start the periodic event listener daemon.
   */
  const start = () => {
    if (isRunning) return { stop };
    isRunning = true;

    const effectiveIntervalMs = Math.min(Math.max(100, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS), 5000);

    logger.info('soroban_event_listener_started', {
      intervalMs: effectiveIntervalMs,
      contractIds,
      queueName,
    });

    pollOnce().catch((err) => {
      logger.error('soroban_event_listener_poll_error', { error: err.message });
    });

    timer = setInterval(() => {
      pollOnce().catch((err) => {
        logger.error('soroban_event_listener_poll_error', { error: err.message });
      });
    }, effectiveIntervalMs);

    if (timer.unref) timer.unref();

    return { stop };
  };

  /**
   * Stop the event listener daemon.
   */
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isRunning = false;
    logger.info('soroban_event_listener_stopped');
  };

  const getState = () => ({
    isRunning,
    cursor,
    startLedger: currentStartLedger,
    seenCount: seenEventIds.size,
  });

  return {
    pollOnce,
    start,
    stop,
    getState,
  };
};

module.exports = {
  DEFAULT_NOTIFICATION_QUEUE,
  DEFAULT_POLL_INTERVAL_MS,
  normalizeNativeValue,
  parseScValToJs,
  encodeTopicFilterSegment,
  buildEventFilters,
  parseContractEvent,
  matchesEventFilter,
  createSorobanEventListener,
};
