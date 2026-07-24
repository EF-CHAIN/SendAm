// Deposit poller unit tests — #31
//
// All four hard rules from the spec, plus cursor-before-notify ordering.
//
// Nothing touches the network or the database: Horizon and Prisma are both
// replaced with in-memory fakes before any SUT module is loaded.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Module isolation — inject stubs into require.cache before loading the SUT.
// Same pattern as payment.orchestrator.test.js.
// ---------------------------------------------------------------------------

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

// Stub out every module the SUT transitively requires that touches native
// packages or Postgres.  The horizon server and prisma client are injected
// as deps at call-time, so these stubs just need to satisfy require() without
// crashing.
injectMock('config/stellar', () => ({
  server: {},   // real server passed via deps, not the module default
  StellarSdk: {},
}));
injectMock('common/prisma', () => ({}));
injectMock('services/whatsapp.service', () => ({
  sendTextMessage: async () => null,
}));
injectMock('pricing/pricing.service', () => ({
  getExchangeRate: async () => null,
}));
// config/env is pulled in by config/stellar transitively; stub minimally.
injectMock('config/env', () => ({
  env: 'test',
  isProduction: false,
  stellar: { network: 'testnet', horizonUrl: '', usdcIssuer: '' },
  messageTransport: 'sim',
}));

// Load the SUT once — all stubs are already in cache.
const {
  startDepositPoller,
  formatDepositMessage,
  pollWallet,
  runDepositSweep,
} = require('../src/jobs/deposits.jobs');

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const WALLET_PUBLIC_KEY = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZNN4F4RJ9A5GD4G7GGY3';
const PHONE = '+2349000000001';

// Build a minimal Prisma mock. `updateLog` records every update in order.
const makePrisma = (wallets, updateLog = []) => ({
  wallet: {
    findMany: async () => wallets,
    findUnique: async ({ where }) => wallets.find((w) => w.id === where.id) || null,
    update: async ({ where, data }) => {
      updateLog.push({ id: where.id, data: { ...data } });
      const w = wallets.find((w) => w.id === where.id);
      if (w) Object.assign(w, data);
      return w;
    },
  },
});

// Build a Horizon fake whose payments() chain returns pages from a list of
// record arrays (one array per call() invocation).
const makeHorizon = (pages) => {
  let callIndex = 0;
  const nextPage = () => {
    const records = pages[callIndex] || [];
    callIndex += 1;
    return { records };
  };
  return {
    payments: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            // cursor() may or may not be called depending on whether cursor is null.
            cursor: () => ({ call: async () => nextPage() }),
            call: async () => nextPage(),
          }),
        }),
      }),
    }),
  };
};

// Build a payment record the way Horizon returns it.
const makePayment = ({ to, from, amount, asset_type = 'credit_alphanum4', asset_code = 'USDC', paging_token }) => ({
  type: 'payment',
  to,
  from,
  amount,
  asset_type,
  asset_code,
  paging_token,
});

// ---------------------------------------------------------------------------
// 1. New inbound payment → exactly one notification, cursor advanced
// ---------------------------------------------------------------------------
describe('Rule 1 — new inbound payment: one notification, cursor advanced', () => {
  test('single inbound payment notifies and advances the cursor', async () => {
    const updateLog = [];
    const wallet = { id: 'w1', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: 'cursor_0' };
    const prismaClient = makePrisma([wallet], updateLog);
    const notified = [];
    const notify = async (phone, text) => notified.push({ phone, text });

    const inboundRecord = makePayment({
      to: WALLET_PUBLIC_KEY,
      from: 'GOTHER',
      amount: '20.0000000',
      asset_code: 'USDC',
      paging_token: 'cursor_1',
    });
    const horizon = makeHorizon([[inboundRecord]]);

    await pollWallet(wallet, { horizon, prismaClient, notify, fetchRate: async () => 1550 });

    // Exactly one notification
    assert.equal(notified.length, 1, 'expected exactly one notification');
    assert.equal(notified[0].phone, PHONE);
    assert.match(notified[0].text, /You received 20 USDC/);

    // Cursor advanced to the payment's paging_token
    assert.ok(
      updateLog.some((u) => u.data.paymentCursor === 'cursor_1'),
      'cursor should have been advanced to cursor_1',
    );
  });

  test('notification text includes fiat hint when rate is available', async () => {
    const wallet = { id: 'w1', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: 'cursor_0' };
    const prismaClient = makePrisma([wallet]);
    const notified = [];
    const notify = async (_phone, text) => notified.push(text);

    const inboundRecord = makePayment({
      to: WALLET_PUBLIC_KEY, from: 'G_OTHER', amount: '20', paging_token: 'c1',
    });
    const horizon = makeHorizon([[inboundRecord]]);

    await pollWallet(wallet, { horizon, prismaClient, notify, fetchRate: async () => 1550 });

    assert.match(notified[0], /~₦/, 'fiat hint should appear when rate is available');
  });

  test('notification text omits fiat hint when rate fetch fails', async () => {
    const wallet = { id: 'w1', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: 'cursor_0' };
    const prismaClient = makePrisma([wallet]);
    const notified = [];
    const notify = async (_phone, text) => notified.push(text);

    const inboundRecord = makePayment({
      to: WALLET_PUBLIC_KEY, from: 'G_OTHER', amount: '20', paging_token: 'c1',
    });
    const horizon = makeHorizon([[inboundRecord]]);

    await pollWallet(wallet, {
      horizon, prismaClient, notify,
      fetchRate: async () => { throw new Error('rate unavailable'); },
    });

    assert.doesNotMatch(notified[0], /~₦/, 'fiat hint should be absent when rate fetch fails');
  });
});

// ---------------------------------------------------------------------------
// 2. Re-running with the same cursor → zero notifications
// ---------------------------------------------------------------------------
describe('Rule 2 — same cursor: no notifications', () => {
  test('empty page produces no notifications', async () => {
    const wallet = { id: 'w1', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: 'cursor_5' };
    const prismaClient = makePrisma([wallet]);
    const notified = [];
    const notify = async (_phone, text) => notified.push(text);

    const horizon = makeHorizon([[]]); // empty page
    await pollWallet(wallet, { horizon, prismaClient, notify, fetchRate: async () => null });

    assert.equal(notified.length, 0, 'no notifications expected on empty page');
  });
});

// ---------------------------------------------------------------------------
// 3. Outbound payments and old history never notify
// ---------------------------------------------------------------------------
describe('Rule 3 — outbound payments are ignored', () => {
  test('a payment where `to` is not this wallet does not notify', async () => {
    const wallet = { id: 'w1', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: 'cursor_0' };
    const prismaClient = makePrisma([wallet]);
    const notified = [];
    const notify = async (_phone, text) => notified.push(text);

    // Outbound: `from` is this wallet, `to` is someone else
    const outboundRecord = makePayment({
      to: 'GOTHER_ACCOUNT',
      from: WALLET_PUBLIC_KEY,
      amount: '50',
      paging_token: 'cursor_2',
    });
    const horizon = makeHorizon([[outboundRecord]]);

    await pollWallet(wallet, { horizon, prismaClient, notify, fetchRate: async () => null });

    assert.equal(notified.length, 0, 'outbound payment must not produce a notification');
  });

  test('non-payment record types (create_account) are ignored', async () => {
    const wallet = { id: 'w1', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: 'cursor_0' };
    const prismaClient = makePrisma([wallet]);
    const notified = [];
    const notify = async (_phone, text) => notified.push(text);

    const createAccount = {
      type: 'create_account',
      account: WALLET_PUBLIC_KEY,
      funder: 'G_FUNDER',
      starting_balance: '10000',
      paging_token: 'cursor_3',
    };
    const horizon = makeHorizon([[createAccount]]);

    await pollWallet(wallet, { horizon, prismaClient, notify, fetchRate: async () => null });

    assert.equal(notified.length, 0, 'create_account record must not produce a notification');
  });
});

// ---------------------------------------------------------------------------
// 4. One failing wallet doesn't stop the others
// ---------------------------------------------------------------------------
describe('Rule 4 — one failing wallet does not stall the loop', () => {
  test('Horizon error on wallet A is logged; wallet B still gets notified', async () => {
    const BAD_KEY = 'GBAD_KEY000000000000000000000000000000000000000000000000000';
    const walletA = { id: 'wA', publicKey: BAD_KEY, phoneNumber: '+2340000000001', paymentCursor: 'cA' };
    const walletB = { id: 'wB', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: 'cB' };

    const prismaClient = makePrisma([walletA, walletB]);
    const notified = [];
    const notify = async (phone, text) => notified.push({ phone, text });

    // Horizon: wallet A always throws; wallet B returns one inbound payment.
    const horizon = {
      payments: () => ({
        forAccount: (pk) => ({
          order: () => ({
            limit: () => ({
              cursor: () => ({
                call: async () => {
                  if (pk === BAD_KEY) throw new Error('Horizon 404: account not found');
                  return {
                    records: [
                      makePayment({ to: WALLET_PUBLIC_KEY, from: 'G_SENDER', amount: '15', paging_token: 'cB1' }),
                    ],
                  };
                },
              }),
            }),
          }),
        }),
      }),
    };

    await runDepositSweep({ horizon, prismaClient, notify, fetchRate: async () => null });

    // Wallet B was still notified despite wallet A erroring
    assert.equal(notified.length, 1, 'wallet B should have been notified even though wallet A failed');
    assert.equal(notified[0].phone, PHONE);
  });
});

// ---------------------------------------------------------------------------
// 5. Cursor written BEFORE notification (cursor-before-notify ordering)
// ---------------------------------------------------------------------------
describe('Rule 5 — cursor written before notification', () => {
  test('DB update precedes the notify call in the event log', async () => {
    const wallet = { id: 'w1', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: 'cursor_0' };
    const events = []; // shared ordered event log

    const prismaClient = {
      wallet: {
        findMany: async () => [wallet],
        findUnique: async () => wallet,
        update: async ({ data }) => {
          events.push({ type: 'db_update', cursor: data.paymentCursor });
          Object.assign(wallet, data);
          return wallet;
        },
      },
    };
    const notify = async (_phone, text) => {
      events.push({ type: 'notify', text });
    };

    const inboundRecord = makePayment({
      to: WALLET_PUBLIC_KEY, from: 'G_SENDER', amount: '10', paging_token: 'cursor_1',
    });
    const horizon = makeHorizon([[inboundRecord]]);

    await pollWallet(wallet, { horizon, prismaClient, notify, fetchRate: async () => null });

    // Find the first db_update with the new cursor and the first notify
    const firstUpdate = events.findIndex((e) => e.type === 'db_update' && e.cursor === 'cursor_1');
    const firstNotify = events.findIndex((e) => e.type === 'notify');

    assert.ok(firstUpdate !== -1, 'a db_update event with the new cursor should exist');
    assert.ok(firstNotify !== -1, 'a notify event should exist');
    assert.ok(
      firstUpdate < firstNotify,
      `cursor DB write (index ${firstUpdate}) must happen before notify (index ${firstNotify})`,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Null-cursor wallet: initialise without notifying
// ---------------------------------------------------------------------------
describe('Rule 6 — null cursor: initialise without notifying', () => {
  test('first poll of a null-cursor wallet writes cursor but sends no notification', async () => {
    const wallet = { id: 'w1', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: null };
    const updateLog = [];
    const prismaClient = makePrisma([wallet], updateLog);
    const notified = [];
    const notify = async (_phone, text) => notified.push(text);

    // Simulated existing payments that represent "old history"
    const oldPayment = makePayment({
      to: WALLET_PUBLIC_KEY, from: 'G_HIST', amount: '1000', paging_token: 'cursor_historical',
    });
    const horizon = makeHorizon([[oldPayment]]);

    await pollWallet(wallet, { horizon, prismaClient, notify, fetchRate: async () => null });

    assert.equal(notified.length, 0, 'no notification on first null-cursor poll');
    assert.ok(
      updateLog.some((u) => u.data.paymentCursor === 'cursor_historical'),
      "cursor should be advanced to the historical record's paging_token",
    );
  });

  test('null-cursor wallet with an empty page does not write cursor or notify', async () => {
    const wallet = { id: 'w1', publicKey: WALLET_PUBLIC_KEY, phoneNumber: PHONE, paymentCursor: null };
    const updateLog = [];
    const prismaClient = makePrisma([wallet], updateLog);
    const notified = [];
    const notify = async (_phone, text) => notified.push(text);

    const horizon = makeHorizon([[]]); // no records at all

    await pollWallet(wallet, { horizon, prismaClient, notify, fetchRate: async () => null });

    assert.equal(notified.length, 0);
    assert.equal(updateLog.length, 0, 'no DB write if there is nothing to initialise to');
  });
});

// ---------------------------------------------------------------------------
// formatDepositMessage pure unit tests
// ---------------------------------------------------------------------------
describe('formatDepositMessage', () => {
  test('formats USDC with fiat hint', () => {
    const msg = formatDepositMessage('20.0000000', 'USDC', 1550);
    assert.equal(msg, 'You received 20 USDC (~₦31,000).');
  });

  test('formats native XLM (asset_type = native)', () => {
    const msg = formatDepositMessage('5', 'native', null);
    assert.equal(msg, 'You received 5 XLM.');
  });

  test('omits fiat hint when rate is null', () => {
    const msg = formatDepositMessage('10', 'USDC', null);
    assert.equal(msg, 'You received 10 USDC.');
  });
});
