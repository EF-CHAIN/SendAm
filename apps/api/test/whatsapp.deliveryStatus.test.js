const { test } = require('node:test');
const assert = require('node:assert/strict');

// Set key to prevent startup validateEnv issues if config is loaded
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { recordDeliveryStatus, classifyWhatsappFailure } = require('../src/services/whatsapp.service');

// ---------------------------------------------------------------------------
// Fake prisma: enough of `whatsappStatusEvent` + `notification` to exercise
// recordDeliveryStatus's idempotency, ordering, and retry-enqueue behaviour
// without a real database.
// ---------------------------------------------------------------------------
const makeFakePrisma = (notifications = []) => {
  const events = new Set();
  const byId = new Map(notifications.map((n) => [n.id, { ...n }]));

  return {
    _byId: byId,
    whatsappStatusEvent: {
      create: async ({ data }) => {
        const key = `${data.providerMessageId}|${data.status}|${data.statusTimestamp.toISOString()}`;
        if (events.has(key)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        events.add(key);
        return data;
      },
    },
    notification: {
      findFirst: async ({ where }) => {
        for (const n of byId.values()) {
          if (n.providerMessageId === where.providerMessageId) return { ...n };
        }
        return null;
      },
      update: async ({ where, data }) => {
        const existing = byId.get(where.id);
        if (!existing) throw new Error(`Notification ${where.id} not found`);
        Object.assign(existing, data);
        return { ...existing };
      },
    },
  };
};

const baseNotification = (overrides = {}) => ({
  id: 'notif_1',
  userId: 'user_1',
  channel: 'whatsapp',
  type: 'transaction_receipt',
  recipient: '+12345',
  body: 'Payment success. Receipt: tx_1',
  status: 'sent',
  providerMessageId: 'wamid.001',
  referenceType: 'transaction',
  referenceId: 'tx_1',
  retryable: false,
  retryCount: 0,
  lastStatusAt: new Date('2026-08-21T10:00:00.000Z'),
  ...overrides,
});

const statusEntry = (overrides = {}) => ({
  id: 'wamid.001',
  status: 'delivered',
  timestamp: String(Math.floor(new Date('2026-08-21T10:01:00.000Z').getTime() / 1000)),
  recipient_id: '+12345',
  ...overrides,
});

test('records a valid status and advances the matching notification', async () => {
  const prisma = makeFakePrisma([baseNotification()]);
  const result = await recordDeliveryStatus(statusEntry(), { prisma });

  assert.equal(result.result, 'recorded');
  assert.equal(prisma._byId.get('notif_1').status, 'delivered');
  assert.ok(prisma._byId.get('notif_1').deliveredAt);
});

test('malformed payloads (missing id/status/timestamp) are ignored, not thrown', async () => {
  const prisma = makeFakePrisma([baseNotification()]);

  const r1 = await recordDeliveryStatus({ status: 'delivered', timestamp: '123' }, { prisma });
  const r2 = await recordDeliveryStatus({ id: 'wamid.001', timestamp: '123' }, { prisma });
  const r3 = await recordDeliveryStatus({ id: 'wamid.001', status: 'bogus', timestamp: '123' }, { prisma });

  assert.equal(r1.result, 'malformed');
  assert.equal(r2.result, 'malformed');
  assert.equal(r3.result, 'malformed');
  assert.equal(prisma._byId.get('notif_1').status, 'sent', 'malformed entries never touch the notification');
});

test('an exact duplicate status callback is a no-op (idempotent)', async () => {
  const prisma = makeFakePrisma([baseNotification()]);
  const entry = statusEntry();

  const first = await recordDeliveryStatus(entry, { prisma });
  assert.equal(first.result, 'recorded');

  const second = await recordDeliveryStatus({ ...entry }, { prisma });
  assert.equal(second.result, 'duplicate');
  // Still just the one advance from the first call.
  assert.equal(prisma._byId.get('notif_1').status, 'delivered');
});

test('a status with no matching notification is recorded as unmatched, not an error', async () => {
  const prisma = makeFakePrisma([]);
  const result = await recordDeliveryStatus(statusEntry({ id: 'wamid.unknown' }), { prisma });
  assert.equal(result.result, 'unmatched');
});

test('an out-of-order callback (older timestamp, lower-rank status) does not regress the notification', async () => {
  const prisma = makeFakePrisma([baseNotification({
    status: 'delivered',
    lastStatusAt: new Date('2026-08-21T10:05:00.000Z'),
  })]);

  // A "sent" event that arrives late, after "delivered" was already recorded.
  const result = await recordDeliveryStatus(statusEntry({
    status: 'sent',
    timestamp: String(Math.floor(new Date('2026-08-21T10:01:00.000Z').getTime() / 1000)),
  }), { prisma });

  assert.equal(result.result, 'out_of_order');
  assert.equal(prisma._byId.get('notif_1').status, 'delivered', 'status is not regressed to sent');
});

test('a notification already terminally failed ignores any later callback', async () => {
  const prisma = makeFakePrisma([baseNotification({ status: 'failed' })]);
  const result = await recordDeliveryStatus(statusEntry({ status: 'read' }), { prisma });

  assert.equal(result.result, 'terminal_ignored');
  assert.equal(prisma._byId.get('notif_1').status, 'failed');
});

test('classifyWhatsappFailure: known transient codes are retryable, known permanent and unknown codes are not', () => {
  assert.equal(classifyWhatsappFailure('131026').retryable, true);
  assert.equal(classifyWhatsappFailure('131047').retryable, false);
  assert.equal(classifyWhatsappFailure('999999').retryable, false);
  assert.equal(classifyWhatsappFailure(undefined).retryable, false);
});

test('a retryable failed callback on a referenced (transaction) notification enqueues a bounded retry', async () => {
  const prisma = makeFakePrisma([baseNotification({ referenceType: 'transaction', retryCount: 0 })]);
  const enqueued = [];
  const enqueueImpl = async (queueName, jobName, data, options) => {
    enqueued.push({ queueName, jobName, data, options });
  };

  const result = await recordDeliveryStatus(statusEntry({
    status: 'failed',
    errors: [{ code: 131026, title: 'Undeliverable', message: 'temporary failure' }],
  }), { prisma, enqueueImpl });

  assert.equal(result.result, 'recorded');
  assert.equal(result.retried, true);
  const notif = prisma._byId.get('notif_1');
  assert.equal(notif.status, 'failed');
  assert.equal(notif.retryable, true);
  assert.equal(notif.retryCount, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].queueName, 'whatsapp-outbound-retry');
  assert.equal(enqueued[0].data.originalNotificationId, 'notif_1');
  assert.equal(enqueued[0].data.recipient, '+12345');
});

test('a non-retryable failed callback (permanent error code) does not enqueue a retry', async () => {
  const prisma = makeFakePrisma([baseNotification({ referenceType: 'transaction' })]);
  const enqueued = [];
  const enqueueImpl = async (...args) => enqueued.push(args);

  const result = await recordDeliveryStatus(statusEntry({
    status: 'failed',
    errors: [{ code: 131047, title: 'Re-engagement message', message: 'outside window' }],
  }), { prisma, enqueueImpl });

  assert.equal(result.retried, false);
  assert.equal(enqueued.length, 0);
  assert.equal(prisma._byId.get('notif_1').retryable, false);
});

test('a retryable failure without a domain reference (referenceType null) does not enqueue a retry', async () => {
  const prisma = makeFakePrisma([baseNotification({ referenceType: null, referenceId: null })]);
  const enqueued = [];
  const enqueueImpl = async (...args) => enqueued.push(args);

  const result = await recordDeliveryStatus(statusEntry({
    status: 'failed',
    errors: [{ code: 131026 }],
  }), { prisma, enqueueImpl });

  assert.equal(result.retried, false);
  assert.equal(enqueued.length, 0);
});

test('retries are bounded: a notification already at the retry cap is not retried again', async () => {
  const prisma = makeFakePrisma([baseNotification({ referenceType: 'transaction', retryCount: 2 })]);
  const enqueued = [];
  const enqueueImpl = async (...args) => enqueued.push(args);

  const result = await recordDeliveryStatus(statusEntry({
    status: 'failed',
    errors: [{ code: 131026 }],
  }), { prisma, enqueueImpl });

  assert.equal(result.retried, false);
  assert.equal(enqueued.length, 0);
  assert.equal(prisma._byId.get('notif_1').retryCount, 2, 'retry count is not incremented past the cap');
});
