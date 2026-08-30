'use strict';

/**
 * Event Sourcing Service (#318)
 * ─────────────────────────────
 * Provides a durable, append-only event log for execution-critical workflows.
 * Captures who, what, when, and why for payment events, KYC transitions,
 * wallet lifecycle, and admin actions.
 *
 * Each event is chained: it references the previous event's hash so the log
 * is tamper-evident. Events are immutable once written — no update or delete
 * path exists in this module.
 *
 * Event categories:
 *   payment.*       — payment lifecycle (initiated, submitted, settled, failed, refunded)
 *   wallet.*        — wallet creation, funding, trustline
 *   kyc.*           — KYC state transitions
 *   admin.*         — admin overrides and configuration changes
 *   account.*       — account deactivation / reactivation
 *   compliance.*    — compliance checks, limits, risk scoring
 */

const crypto = require('crypto');
const prisma = require('./prisma');
const logger = require('../utils/logger');
const env = require('../config/env');

// ── Event type registry ─────────────────────────────────────────────────
const EVENT_TYPES = Object.freeze({
  // Payment lifecycle
  PAYMENT_INITIATED:          'payment.initiated',
  PAYMENT_SUBMITTED:          'payment.submitted',
  PAYMENT_SETTLED:            'payment.settled',
  PAYMENT_FAILED:             'payment.failed',
  PAYMENT_REFUND_INITIATED:   'payment.refund.initiated',
  PAYMENT_REFUND_SETTLED:     'payment.refund.settled',
  PAYMENT_QUOTE_CREATED:      'payment.quote.created',
  PAYMENT_QUOTE_CONSUMED:     'payment.quote.consumed',
  PAYMENT_QUOTE_EXPIRED:      'payment.quote.expired',

  // Wallet lifecycle
  WALLET_CREATED:             'wallet.created',
  WALLET_FUNDED:              'wallet.funded',
  WALLET_FUNDING_FAILED:      'wallet.funding.failed',
  WALLET_TRUSTLINE_OPENED:    'wallet.trustline.opened',
  WALLET_TRUSTLINE_FAILED:    'wallet.trustline.failed',

  // KYC / compliance
  KYC_STARTED:                'kyc.started',
  KYC_SUBMITTED:              'kyc.submitted',
  KYC_APPROVED:               'kyc.approved',
  KYC_REJECTED:               'kyc.rejected',
  KYC_REVIEW_REQUIRED:        'kyc.review_required',
  KYC_OVERRIDE_SUBMITTED:     'kyc.override.submitted',
  KYC_OVERRIDE_APPROVED:      'kyc.override.approved',
  COMPLIANCE_LIMIT_ENFORCED:  'compliance.limit.enforced',
  COMPLIANCE_RISK_SCORED:     'compliance.risk.scored',

  // Account lifecycle (#332)
  ACCOUNT_DEACTIVATED:        'account.deactivated',
  ACCOUNT_REACTIVATED:        'account.reactivated',
  ACCOUNT_DEACTIVATION_BLOCKED: 'account.deactivation.blocked',

  // Admin
  ADMIN_ACTION:               'admin.action',
});

// ── Internal helpers ────────────────────────────────────────────────────

const secret = () => env.encryptionKey || 'event-secret-fallback';

/**
 * Compute a chained HMAC over the event payload.
 * The previous event's hash is included so any deletion or reordering
 * of records is detectable.
 */
const computeHash = (previousHash, payload) => {
  const content = JSON.stringify({ previousHash, ...payload });
  return crypto.createHmac('sha256', secret()).update(content).digest('hex');
};

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Append an immutable domain event to the WorkflowEvent ledger.
 *
 * @param {object} opts
 * @param {string}  opts.eventType       — One of EVENT_TYPES values.
 * @param {string} [opts.aggregateType]  — Domain object type (Transaction, Wallet, User, …).
 * @param {string} [opts.aggregateId]    — ID of the domain object.
 * @param {string} [opts.actorType]      — 'user' | 'administrator' | 'system'.
 * @param {string} [opts.actorId]        — ID of the actor (userId or adminId).
 * @param {object} [opts.payload]        — Structured event data (who, what, why, context).
 * @param {object} [opts.tx]             — Optional Prisma transaction client.
 * @returns {Promise<object>}            — The created WorkflowEvent row.
 */
const appendEvent = async ({
  eventType,
  aggregateType,
  aggregateId,
  actorType = 'system',
  actorId,
  payload = {},
  tx,
}) => {
  const db = tx || prisma;

  try {
    return await (tx ? appendEventInner(db, { eventType, aggregateType, aggregateId, actorType, actorId, payload }) : prisma.$transaction((innerTx) => appendEventInner(innerTx, { eventType, aggregateType, aggregateId, actorType, actorId, payload })));
  } catch (error) {
    logger.error('Failed to append workflow event', { eventType, error: error.message });
    return null;
  }
};

const appendEventInner = async (db, { eventType, aggregateType, aggregateId, actorType, actorId, payload }) => {
  const last = await db.workflowEvent.findFirst({ orderBy: { id: 'desc' } });
  const previousHash = last?.hash || null;

  const eventData = {
    eventType,
    aggregateType: aggregateType || null,
    aggregateId: aggregateId || null,
    actorType,
    actorId: actorId || null,
    payload,
  };

  const hash = computeHash(previousHash, eventData);

  return db.workflowEvent.create({
    data: {
      ...eventData,
      previousHash,
      hash,
    },
  });
};

/**
 * Query events for a specific aggregate (e.g. all events for a Transaction).
 */
const getEventsForAggregate = async ({ aggregateType, aggregateId, limit = 100 }) => {
  return prisma.workflowEvent.findMany({
    where: { aggregateType, aggregateId },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
};

/**
 * Query events by type with optional date range.
 */
const queryEvents = async ({ eventType, actorType, actorId, aggregateType, from, to, limit = 100, after } = {}) => {
  const where = {};
  if (eventType) where.eventType = eventType;
  if (actorType) where.actorType = actorType;
  if (actorId) where.actorId = actorId;
  if (aggregateType) where.aggregateType = aggregateType;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const cursor = after ? { id: after } : undefined;
  const skip = cursor ? 1 : 0;

  const events = await prisma.workflowEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    skip,
    cursor,
  });

  const hasMore = events.length > limit;
  const items = hasMore ? events.slice(0, limit) : events;
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
};

/**
 * Verify the integrity of the event chain.
 * Checks each record's hash against recomputed values and validates chain linkage.
 */
const verifyEventChain = async () => {
  const events = await prisma.workflowEvent.findMany({ orderBy: { createdAt: 'asc' } });
  if (events.length === 0) return { valid: true, errors: [] };

  const hashSet = new Set(events.map((e) => e.hash));
  const errors = [];
  let nullPreviousCount = 0;

  for (const event of events) {
    const payload = {
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      actorType: event.actorType,
      actorId: event.actorId,
      payload: event.payload,
    };
    const computed = computeHash(event.previousHash, payload);

    if (computed !== event.hash) {
      errors.push({ id: event.id, issue: 'Hash mismatch: record may have been altered' });
    }

    if (event.previousHash === null) {
      nullPreviousCount++;
    } else if (!hashSet.has(event.previousHash)) {
      errors.push({ id: event.id, issue: 'Chain broken: previous record missing or deleted' });
    }
  }

  if (nullPreviousCount > 1) {
    errors.push({ issue: `Multiple genesis events found (${nullPreviousCount}) — chain may be split` });
  }

  return { valid: errors.length === 0, errors, total: events.length };
};

module.exports = {
  EVENT_TYPES,
  appendEvent,
  getEventsForAggregate,
  queryEvents,
  verifyEventChain,
};
