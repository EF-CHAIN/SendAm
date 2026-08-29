// Unified idempotency, replay protection and ordering guard for every
// external callback (#311).
//
// Each callback path had grown its own dedup scheme — WhatsApp inbound
// messages claim a `ProcessedMessage` row, KYC uses `KycWebhookEvent`,
// delivery statuses lean on a composite unique index — and paths added since
// have none at all. This module is the one place that answers "have we
// already processed this, and is it still in order?", so a new provider gets
// replay safety by declaring a key rather than by inventing a scheme.
//
// The record is keyed on (source, eventKey) and carries a payload hash, so a
// provider that reuses an event id with different content is reported as a
// conflict instead of being silently swallowed as a duplicate.

const crypto = require('crypto');
const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');

/** Terminal and non-terminal states a callback record can be in. */
const STATE = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/** Why a callback was not processed. Mirrored into logs and metrics. */
const OUTCOME = {
  PROCESSED: 'processed',
  DUPLICATE: 'duplicate',
  IN_FLIGHT: 'in_flight',
  STALE: 'stale',
  CONFLICT: 'conflict',
  FAILED: 'failed',
};

/**
 * Stable hash of a callback body.
 *
 * Object keys are sorted so that two deliveries of the same event hash
 * identically regardless of provider key ordering — otherwise every redelivery
 * would look like a payload conflict.
 */
const hashPayload = (payload) => {
  const canonical = JSON.stringify(payload, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce((acc, key) => {
          acc[key] = value[key];
          return acc;
        }, {});
    }
    return value;
  });
  return crypto.createHash('sha256').update(canonical || '').digest('hex');
};

/**
 * Build the idempotency key for a callback.
 *
 * Providers do not agree on what identifies an event: Meta sends a message id,
 * KYC providers send a job id, some send nothing at all. When a provider gives
 * no id, the payload hash is the key — that still collapses byte-identical
 * redeliveries, which is the common retry case, without pretending we can tell
 * two genuinely distinct but identical-looking events apart.
 */
const buildEventKey = ({ source, eventId, payload }) => {
  if (eventId) return `${source}:${eventId}`;
  return `${source}:sha256:${hashPayload(payload)}`;
};

const toDate = (value) => {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // Providers send seconds, milliseconds, or ISO strings. Seconds are the
  // common WhatsApp case and would otherwise land in 1970.
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * Decide whether an event is older than what we have already applied to the
 * same subject.
 *
 * Ordering is per subject, not global: two customers' callbacks are unrelated,
 * and a global sequence would drop one customer's event because another's
 * arrived first. A callback with no subject or no timestamp is never treated
 * as stale — refusing to process an event because we cannot order it would
 * lose data that duplicate detection alone would have handled correctly.
 */
const isStale = ({ lastAppliedAt, eventAt }) => {
  if (!lastAppliedAt || !eventAt) return false;
  return eventAt.getTime() < lastAppliedAt.getTime();
};

/**
 * Run `handler` at most once for a given callback event.
 *
 * Returns `{ outcome, result, record }`. The handler runs only for
 * `processed`; every other outcome means the callback was already accounted
 * for, arrived out of order, or conflicts with what we stored — and each is
 * logged and counted so replay problems are visible rather than inferred from
 * missing side effects.
 *
 * A handler that throws leaves the record in `failed`, which is deliberately
 * re-claimable: provider retries are the recovery path for a transient
 * failure, and a permanently-blocked record would need manual intervention for
 * every blip.
 */
const withIdempotency = async (
  {
    source,
    eventId = null,
    subjectId = null,
    eventTimestamp = null,
    payload = null,
  },
  handler,
  options = {},
) => {
  const db = options.prisma || require('../common/prisma');
  const eventKey = buildEventKey({ source, eventId, payload });
  const payloadHash = hashPayload(payload);
  const eventAt = toDate(eventTimestamp);

  const report = (outcome, extra = {}) => {
    increment('sendam_webhook_idempotency_total', { source, outcome });
    const log = outcome === OUTCOME.PROCESSED ? logger.info : logger.warn;
    log('webhook_idempotency', { source, eventKey, subjectId, outcome, ...extra });
  };

  let record = null;
  try {
    record = await db.webhookEvent.create({
      data: {
        source,
        eventKey,
        subjectId,
        payloadHash,
        eventAt,
        state: STATE.PROCESSING,
        attempts: 1,
      },
    });
  } catch (error) {
    // P2002 is the unique index on (source, eventKey) — this event has been
    // seen before. Everything else is a real database failure and must not be
    // mistaken for a duplicate.
    if (error.code !== 'P2002') throw error;

    const existing = await db.webhookEvent.findUnique({
      where: { source_eventKey: { source, eventKey } },
    });

    if (!existing) throw error;

    if (existing.payloadHash !== payloadHash) {
      report(OUTCOME.CONFLICT, { storedHash: existing.payloadHash, incomingHash: payloadHash });
      return { outcome: OUTCOME.CONFLICT, result: null, record: existing };
    }
    if (existing.state === STATE.COMPLETED) {
      report(OUTCOME.DUPLICATE);
      return { outcome: OUTCOME.DUPLICATE, result: null, record: existing };
    }
    if (existing.state === STATE.PROCESSING) {
      // A concurrent delivery holds the claim. Reporting in_flight lets the
      // caller answer retryably instead of acknowledging work that may still
      // fail in the other request.
      report(OUTCOME.IN_FLIGHT);
      return { outcome: OUTCOME.IN_FLIGHT, result: null, record: existing };
    }

    const reclaimed = await db.webhookEvent.updateMany({
      where: { id: existing.id, state: STATE.FAILED },
      data: { state: STATE.PROCESSING, attempts: existing.attempts + 1, error: null },
    });
    if (reclaimed.count !== 1) {
      report(OUTCOME.IN_FLIGHT);
      return { outcome: OUTCOME.IN_FLIGHT, result: null, record: existing };
    }
    record = { ...existing, state: STATE.PROCESSING };
  }

  if (subjectId && eventAt) {
    const newest = await db.webhookEvent.findFirst({
      where: {
        source,
        subjectId,
        state: STATE.COMPLETED,
        eventAt: { not: null },
        NOT: { id: record.id },
      },
      orderBy: { eventAt: 'desc' },
    });

    if (isStale({ lastAppliedAt: newest?.eventAt, eventAt })) {
      // Out of order: a newer event for this subject has already been applied.
      // Recording it as completed keeps the replay history intact while making
      // sure the stale handler never runs.
      await db.webhookEvent.update({
        where: { id: record.id },
        data: { state: STATE.COMPLETED, processedAt: new Date(), skippedReason: OUTCOME.STALE },
      });
      report(OUTCOME.STALE, { eventAt: eventAt.toISOString(), lastAppliedAt: newest.eventAt.toISOString() });
      return { outcome: OUTCOME.STALE, result: null, record };
    }
  }

  try {
    const result = await handler({ eventKey, record });
    await db.webhookEvent.update({
      where: { id: record.id },
      data: { state: STATE.COMPLETED, processedAt: new Date(), error: null },
    });
    report(OUTCOME.PROCESSED);
    return { outcome: OUTCOME.PROCESSED, result, record };
  } catch (error) {
    await db.webhookEvent
      .update({
        where: { id: record.id },
        data: { state: STATE.FAILED, error: String(error.message || error).slice(0, 500) },
      })
      .catch(() => {});
    report(OUTCOME.FAILED, { error: error.message });
    throw error;
  }
};

/**
 * Whether a caller should acknowledge the delivery (2xx) or ask the provider
 * to retry. Only an in-flight claim is worth retrying: the other outcomes are
 * settled, and asking a provider to redeliver a duplicate forever is how a
 * webhook queue backs up.
 */
const shouldAcknowledge = (outcome) => outcome !== OUTCOME.IN_FLIGHT;

module.exports = {
  STATE,
  OUTCOME,
  hashPayload,
  buildEventKey,
  isStale,
  withIdempotency,
  shouldAcknowledge,
};
