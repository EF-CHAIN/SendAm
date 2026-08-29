const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  pollWallet,
  processDepositOutbox,
  replayFailedDepositOutboxRecord,
  replayAllDeadLetters,
  cleanupDeliveredOutboxRecords,
} = require('../src/jobs/deposits.jobs');

describe('Deposit Notification Outbox (#158)', () => {
  test('atomically creates outbox record and updates cursor when deposit detected', async () => {
    const wallet = {
      id: 'w1',
      userId: 'u1',
      publicKey: 'GPUBLICKEY123',
      phoneNumber: '+2348000000001',
      paymentCursor: '100',
    };

    const outboxStore = new Map();
    let updatedCursor = null;

    const fakeHorizon = {
      payments: () => ({
        forAccount: () => ({
          order: () => ({
            limit: () => ({
              cursor: () => ({
                call: async () => ({
                  records: [
                    {
                      id: 'op123',
                      paging_token: '101',
                      type: 'payment',
                      to: 'GPUBLICKEY123',
                      amount: '50.0000000',
                      asset_type: 'USDC',
                    },
                  ],
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const fakePrisma = {
      wallet: {
        update: async (args) => {
          updatedCursor = args.data.paymentCursor;
        },
        findUnique: async () => ({ paymentCursor: updatedCursor || '101' }),
      },
      depositOutboxRecord: {
        upsert: async (args) => {
          outboxStore.set(args.where.stellarPaymentId, {
            id: 'ob1',
            ...args.create,
          });
        },
        updateMany: async (args) => {
          const item = outboxStore.get(args.where.stellarPaymentId);
          if (item) {
            Object.assign(item, args.data);
          }
        },
      },
      $transaction: async (fn) => fn(fakePrisma),
    };

    let notifyCalled = false;
    const fakeNotify = async () => {
      notifyCalled = true;
      return { messageId: 'wamid.test123' };
    };

    await pollWallet(wallet, {
      horizon: fakeHorizon,
      prismaClient: fakePrisma,
      notify: fakeNotify,
      fetchRate: async () => 1500,
    });

    assert.equal(updatedCursor, '101');
    assert.equal(outboxStore.has('101'), true);
    assert.equal(notifyCalled, true);

    const outboxItem = outboxStore.get('101');
    assert.equal(outboxItem.status, 'delivered');
    assert.equal(outboxItem.providerMessageId, 'wamid.test123');
    assert.equal(outboxItem.amount, '50.0000000');
  });

  test('processDepositOutbox delivers pending records and sets provider message ID', async () => {
    const outboxRecords = [
      {
        id: 'ob1',
        stellarPaymentId: '101',
        walletId: 'w1',
        userId: 'u1',
        phoneNumber: '+2348000000001',
        message: 'You received 50 USDC (~₦75,000).',
        status: 'pending',
        attempts: 0,
      },
    ];

    const updated = [];

    const fakePrisma = {
      depositOutboxRecord: {
        findMany: async () => outboxRecords,
        update: async (args) => {
          updated.push(args);
        },
      },
    };

    const fakeNotify = async () => ({ messageId: 'wamid.outbox1' });

    const result = await processDepositOutbox({
      prismaClient: fakePrisma,
      notify: fakeNotify,
      maxAttempts: 5,
    });

    assert.equal(result.processed, 1);
    assert.equal(result.delivered, 1);
    assert.equal(updated.length, 1);
    assert.equal(updated[0].data.status, 'delivered');
    assert.equal(updated[0].data.providerMessageId, 'wamid.outbox1');
  });

  test('processDepositOutbox transitions to dead_letter when max attempts reached', async () => {
    const outboxRecords = [
      {
        id: 'ob2',
        stellarPaymentId: '102',
        walletId: 'w1',
        userId: 'u1',
        phoneNumber: '+2348000000001',
        message: 'You received 10 USDC.',
        status: 'pending',
        attempts: 4,
      },
    ];

    const updated = [];

    const fakePrisma = {
      depositOutboxRecord: {
        findMany: async () => outboxRecords,
        update: async (args) => {
          updated.push(args);
        },
      },
    };

    const fakeNotify = async () => {
      throw new Error('WhatsApp gateway offline');
    };

    const result = await processDepositOutbox({
      prismaClient: fakePrisma,
      notify: fakeNotify,
      maxAttempts: 5,
    });

    assert.equal(result.processed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.deadLetters, 1);
    assert.equal(updated.length, 1);
    assert.equal(updated[0].data.status, 'dead_letter');
    assert.equal(updated[0].data.attempts, 5);
    assert.equal(updated[0].data.lastError, 'WhatsApp gateway offline');
  });

  test('replay tooling resets failed/dead_letter outbox records to pending', async () => {
    let resetId = null;
    let resetAll = false;

    const fakePrisma = {
      depositOutboxRecord: {
        update: async (args) => {
          resetId = args.where.id;
          return { id: resetId, ...args.data };
        },
        updateMany: async (args) => {
          resetAll = true;
          return { count: 3 };
        },
      },
    };

    const singleRes = await replayFailedDepositOutboxRecord({ outboxId: 'ob2', prismaClient: fakePrisma });
    assert.equal(singleRes.id, 'ob2');
    assert.equal(singleRes.status, 'pending');
    assert.equal(singleRes.attempts, 0);

    const allRes = await replayAllDeadLetters({ prismaClient: fakePrisma });
    assert.equal(allRes.count, 3);
    assert.equal(resetAll, true);
  });

  test('cleanupDeliveredOutboxRecords deletes delivered records past cutoff', async () => {
    let deletedWhere = null;
    const fakePrisma = {
      depositOutboxRecord: {
        deleteMany: async (args) => {
          deletedWhere = args.where;
          return { count: 12 };
        },
      },
    };

    const res = await cleanupDeliveredOutboxRecords({ olderThanDays: 30, prismaClient: fakePrisma });
    assert.equal(res.count, 12);
    assert.equal(deletedWhere.status, 'delivered');
    assert.ok(deletedWhere.deliveredAt.lt instanceof Date);
  });
});
