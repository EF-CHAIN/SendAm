// Outbound notification outbox (#286).
//
// The previous flow called Meta first and inserted the Notification row only
// after the provider responded. A crash in between left no record at all: the
// message had been sent, later delivery callbacks had nothing to correlate to,
// and no retry decision could be made safely because there was no way to tell
// "never sent" from "sent, unrecorded".
//
// Here the durable intent is written first, claimed atomically, and only then
// handed to the provider. Every provider call therefore has a pre-existing row
// to attach its result to, and an interrupted send is recoverable rather than
// invisible.

const crypto = require('node:crypto');
const logger = require('../utils/logger');

/** Terminal-ish states a row can hold. */
const STATUS = Object.freeze({
  QUEUED: 'queued',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

/**
 * Notification types whose send must never happen without a durable record.
 * For these, a persistence failure aborts the send rather than proceeding
 * untracked — an unrecorded financial or compliance message is worse than a
 * delayed one.
 */
const DURABLE_REQUIRED_TYPES = new Set([
  'payment_sent',
  'payment_received',
  'payment_failed',
  'deposit_received',
  'refund_processed',
  'withdrawal_processed',
  'kyc_status',
  'compliance_notice',
  'security_alert',
]);

const requiresDurableRecord = (notification) =>
  Boolean(notification) && DURABLE_REQUIRED_TYPES.has(notification.type);

/**
 * Stable identity for a logical send.
 *
 * Derived from the notification's own reference data where available, so the
 * same logical send retried after a crash reuses its row instead of creating a
 * second one. Falls back to a random key when a caller has no reference,
 * which degrades to "no dedupe" rather than to "collides with someone else".
 */
const buildIdempotencyKey = (notification, to, body) => {
  if (notification?.idempotencyKey) return notification.idempotencyKey;

  if (notification?.referenceType && notification?.referenceId) {
    return `${notification.channel || 'whatsapp'}:${notification.referenceType}:${notification.referenceId}:${notification.type || 'generic'}`;
  }

  const digest = crypto
    .createHash('sha256')
    .update(`${notification?.userId || ''}|${notification?.type || ''}|${to}|${body}`)
    .digest('hex')
    .slice(0, 32);
  return `${notification?.channel || 'whatsapp'}:auto:${digest}`;
};

class NotificationPersistenceError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NotificationPersistenceError';
    this.code = 'NOTIFICATION_PERSISTENCE_FAILED';
    this.cause = cause;
  }
}

/**
 * Write the queued intent before any provider call.
 *
 * Returns the row, or `null` when persistence failed for a notification that
 * does not require durability (the caller may then proceed untracked, as
 * before). For notifications that do require it, this throws.
 *
 * A row that already exists for the same idempotency key is returned as-is —
 * that is what makes a retry safe.
 */
const reserveOutboundNotification = async (db, { notification, to, body }) => {
  const idempotencyKey = buildIdempotencyKey(notification, to, body);

  try {
    return await db.notification.create({
      data: {
        userId: notification.userId || null,
        channel: notification.channel || 'whatsapp',
        type: notification.type || 'generic',
        recipient: to,
        body,
        status: STATUS.QUEUED,
        referenceType: notification.referenceType || null,
        referenceId: notification.referenceId || null,
        idempotencyKey,
        lastStatusAt: new Date(),
      },
    });
  } catch (error) {
    // P2002: a row for this logical send already exists. Reuse it rather than
    // sending a second copy.
    if (error?.code === 'P2002') {
      const existing = await db.notification.findUnique({ where: { idempotencyKey } });
      if (existing) return existing;
    }

    logger.error('notification_reserve_failed', { message: error.message, idempotencyKey });

    if (requiresDurableRecord(notification)) {
      throw new NotificationPersistenceError(
        `Refusing to send ${notification.type} without a durable record: ${error.message}`,
        error,
      );
    }
    return null;
  }
};

/**
 * Atomically move a reserved row into `sending`.
 *
 * The status guard is what makes this a claim: two workers racing on the same
 * row produce exactly one winner, so a crash-and-retry cannot send twice while
 * an attempt is still in flight.
 *
 * Returns true when this caller owns the send.
 */
const claimForSend = async (db, notificationId, { now = new Date() } = {}) => {
  const claimed = await db.notification.updateMany({
    where: { id: notificationId, status: STATUS.QUEUED },
    data: {
      status: STATUS.SENDING,
      claimedAt: now,
      lastAttemptAt: now,
      sendAttempts: { increment: 1 },
    },
  });
  return claimed.count === 1;
};

/** Attach the provider's result to the row that was reserved before the call. */
const attachProviderResult = async (db, notificationId, { providerMessageId, status, error = null }) => {
  const now = new Date();
  return db.notification.update({
    where: { id: notificationId },
    data: {
      status,
      providerMessageId: providerMessageId || null,
      error,
      sentAt: status === STATUS.SENT ? now : undefined,
      failedAt: status === STATUS.FAILED ? now : undefined,
      lastStatusAt: now,
    },
  });
};

/**
 * Record that a send failed outright, leaving the row durable and inspectable.
 */
const markSendFailed = async (db, notificationId, error) => {
  try {
    await attachProviderResult(db, notificationId, {
      providerMessageId: null,
      status: STATUS.FAILED,
      error: String(error || 'send failed').slice(0, 500),
    });
  } catch (updateError) {
    logger.error('notification_mark_failed_failed', { message: updateError.message, notificationId });
  }
};

/**
 * Sends whose outcome is unknown: claimed, handed to the provider, and never
 * resolved — the signature of a crash mid-flight.
 *
 * These are surfaced rather than blindly retried. The provider may well have
 * accepted the message, so re-sending without reconciling would duplicate a
 * financial notification. Callers reconcile against the provider (or wait for
 * a delivery callback to arrive and match on `providerMessageId`).
 */
const findUnresolvedSends = async (db, { olderThanMs = 5 * 60 * 1000, limit = 100, now = new Date() } = {}) => {
  const cutoff = new Date(now.getTime() - olderThanMs);
  return db.notification.findMany({
    where: { status: STATUS.SENDING, claimedAt: { lt: cutoff } },
    orderBy: { claimedAt: 'asc' },
    take: limit,
  });
};

/**
 * Move a stuck send to `unknown` so it stops being counted as in-flight and
 * becomes visible to operators. Deliberately not `failed`: we do not know that
 * it failed, and saying so would licence an unsafe automatic resend.
 */
const markUnresolved = async (db, notificationId, reason = 'no provider response recorded') => {
  const flagged = await db.notification.updateMany({
    where: { id: notificationId, status: STATUS.SENDING },
    data: {
      status: STATUS.UNKNOWN,
      error: String(reason).slice(0, 500),
      lastStatusAt: new Date(),
    },
  });
  return flagged.count === 1;
};

/** Sweep unresolved sends, flagging each. Returns the ids flagged. */
const reconcileUnresolvedSends = async (db, options = {}) => {
  const stuck = await findUnresolvedSends(db, options);
  const flagged = [];
  for (const row of stuck) {
    if (await markUnresolved(db, row.id)) flagged.push(row.id);
  }
  if (flagged.length) {
    logger.warn('notification_unresolved_sends', { count: flagged.length });
  }
  return flagged;
};

module.exports = {
  STATUS,
  DURABLE_REQUIRED_TYPES,
  NotificationPersistenceError,
  requiresDurableRecord,
  buildIdempotencyKey,
  reserveOutboundNotification,
  claimForSend,
  attachProviderResult,
  markSendFailed,
  findUnresolvedSends,
  markUnresolved,
  reconcileUnresolvedSends,
};
