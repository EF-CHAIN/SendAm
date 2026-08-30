// Durable inbox for provider webhook callbacks (#287).
//
// The webhook previously caught errors from status recording, logged them, and
// still returned 200. Meta treats that as "delivered", so a transient database
// failure permanently destroyed sent/delivered/read/failed evidence — the
// provider will never send it again.
//
// Here each batch item is persisted before the request is acknowledged, and
// processed afterwards with retry, dead-lettering, and replay. Acknowledgement
// then means "we have it durably", not "we managed to process it".

const logger = require('../utils/logger');

const STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  FAILED: 'failed',
  DEAD_LETTER: 'dead_letter',
});

/** Attempts before an event stops being retried and is dead-lettered. */
const MAX_ATTEMPTS = 8;

/** Exponential backoff, capped so a long outage does not stall the queue. */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 15 * 60 * 1000;

const backoffMs = (attempts) =>
  Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);

/**
 * Identity for one status callback item.
 *
 * Meta may redeliver an entire batch when any part of it is not acknowledged,
 * so identity has to be per item, not per request — otherwise a redelivery
 * either duplicates every item or is dropped wholesale. `(id, status,
 * timestamp)` is the same triple the existing status de-duplication uses.
 */
const statusEventKey = (statusEntry) =>
  `status:${statusEntry?.id}:${statusEntry?.status}:${statusEntry?.timestamp}`;

/**
 * Persist one callback item. Idempotent: a redelivered item resolves to the
 * row already stored rather than creating a second one or failing the request.
 *
 * Throws if the write genuinely cannot be made durable — the caller must then
 * refuse to acknowledge, so the provider retries.
 */
const recordInboundEvent = async (db, { eventType, eventKey, payload, provider = 'meta' }) => {
  try {
    const row = await db.webhookInboxEvent.create({
      data: { provider, eventType, eventKey, payload },
    });
    return { row, created: true };
  } catch (error) {
    if (error?.code === 'P2002') {
      const existing = await db.webhookInboxEvent.findUnique({
        where: { provider_eventKey: { provider, eventKey } },
      });
      // `created` distinguishes a genuinely new item from a redelivery. It
      // cannot be inferred from the row's state: a redelivered item that has
      // not been drained yet still looks exactly like a fresh one.
      if (existing) return { row: existing, created: false };
    }
    throw error;
  }
};

/**
 * Persist every status item in a webhook batch.
 *
 * Returns `{ stored, duplicates, failed }`. `failed` being non-empty is what
 * tells the controller it must not acknowledge: some evidence is not durable
 * yet, and only the provider can give it to us again.
 */
const ingestStatusBatch = async (db, statusEntries, { provider = 'meta' } = {}) => {
  const stored = [];
  const duplicates = [];
  const failed = [];

  for (const statusEntry of statusEntries) {
    const eventKey = statusEventKey(statusEntry);
    try {
      const { row, created } = await recordInboundEvent(db, {
        provider,
        eventType: 'status',
        eventKey,
        payload: statusEntry,
      });
      if (created) stored.push(row);
      else duplicates.push(row);
    } catch (error) {
      logger.error('webhook_inbox_persist_failed', { message: error.message, eventKey });
      failed.push({ eventKey, error: error.message });
    }
  }

  return { stored, duplicates, failed };
};

/**
 * Claim one pending event for processing.
 *
 * The status guard makes the claim atomic, so two workers draining the inbox
 * cannot process the same callback twice.
 */
const claimEvent = async (db, eventId, { now = new Date() } = {}) => {
  const claimed = await db.webhookInboxEvent.updateMany({
    where: { id: eventId, status: { in: [STATUS.PENDING, STATUS.FAILED] }, nextAttemptAt: { lte: now } },
    data: { status: STATUS.PROCESSING, claimedAt: now, attempts: { increment: 1 } },
  });
  return claimed.count === 1;
};

const markProcessed = async (db, eventId) =>
  db.webhookInboxEvent.update({
    where: { id: eventId },
    data: { status: STATUS.PROCESSED, processedAt: new Date(), lastError: null },
  });

/**
 * Record a processing failure and schedule the next attempt, or dead-letter
 * the event once it has exhausted its retries. Dead-lettered events are kept
 * and replayable — never discarded.
 */
const markFailed = async (db, eventId, error, { attempts, now = new Date() } = {}) => {
  const attemptCount = Number.isInteger(attempts) ? attempts : MAX_ATTEMPTS;
  const exhausted = attemptCount >= MAX_ATTEMPTS;

  return db.webhookInboxEvent.update({
    where: { id: eventId },
    data: {
      status: exhausted ? STATUS.DEAD_LETTER : STATUS.FAILED,
      lastError: String(error?.message || error || 'processing failed').slice(0, 500),
      nextAttemptAt: exhausted ? now : new Date(now.getTime() + backoffMs(attemptCount)),
    },
  });
};

/**
 * Drain due events through `handler`.
 *
 * Each event is isolated: one failure retries only itself and never blocks the
 * rest of the queue.
 */
const drainInbox = async (db, handler, { limit = 50, now = new Date() } = {}) => {
  const due = await db.webhookInboxEvent.findMany({
    where: { status: { in: [STATUS.PENDING, STATUS.FAILED] }, nextAttemptAt: { lte: now } },
    orderBy: { receivedAt: 'asc' },
    take: limit,
  });

  const result = { processed: 0, failed: 0, skipped: 0 };

  for (const event of due) {
    if (!(await claimEvent(db, event.id, { now }))) {
      result.skipped += 1;
      continue;
    }
    try {
      await handler(event);
      await markProcessed(db, event.id);
      result.processed += 1;
    } catch (error) {
      await markFailed(db, event.id, error, { attempts: event.attempts + 1, now });
      result.failed += 1;
      logger.error('webhook_inbox_process_failed', { message: error.message, eventId: event.id });
    }
  }

  return result;
};

/**
 * Return a dead-lettered or failed event to the queue for another attempt,
 * once an operator has addressed whatever was blocking it.
 */
const replayEvent = async (db, eventId, { now = new Date() } = {}) => {
  const replayed = await db.webhookInboxEvent.updateMany({
    where: { id: eventId, status: { in: [STATUS.DEAD_LETTER, STATUS.FAILED, STATUS.PROCESSING] } },
    data: { status: STATUS.PENDING, attempts: 0, nextAttemptAt: now, lastError: null, claimedAt: null },
  });
  return replayed.count === 1;
};

/**
 * Backlog metrics: how much is waiting, how much has been given up on, and how
 * old the oldest unprocessed event is. Age matters more than depth — a small
 * queue that is not moving is the real failure.
 */
const inboxStats = async (db, { now = new Date() } = {}) => {
  const [pending, failed, deadLettered, oldest] = await Promise.all([
    db.webhookInboxEvent.count({ where: { status: STATUS.PENDING } }),
    db.webhookInboxEvent.count({ where: { status: STATUS.FAILED } }),
    db.webhookInboxEvent.count({ where: { status: STATUS.DEAD_LETTER } }),
    db.webhookInboxEvent.findFirst({
      where: { status: { in: [STATUS.PENDING, STATUS.FAILED] } },
      orderBy: { receivedAt: 'asc' },
      select: { receivedAt: true },
    }),
  ]);

  return {
    pending,
    failed,
    deadLettered,
    backlog: pending + failed,
    oldestPendingAgeMs: oldest ? now.getTime() - new Date(oldest.receivedAt).getTime() : 0,
  };
};

module.exports = {
  STATUS,
  MAX_ATTEMPTS,
  backoffMs,
  statusEventKey,
  recordInboundEvent,
  ingestStatusBatch,
  claimEvent,
  markProcessed,
  markFailed,
  drainInbox,
  replayEvent,
  inboxStats,
};
