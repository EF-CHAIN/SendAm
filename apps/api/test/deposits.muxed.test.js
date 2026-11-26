// Deposit poller × muxed account routing, end to end (#958).
//
// The unit behaviour of the router lives in muxedAccounts.test.js. What this
// file proves is the *integration*: that a muxed payment arriving on a shared
// base account is credited to the sub-account's owner and alerted to that
// owner, that the poller's existing cursor/outbox guarantees still hold, and
// that an unclaimed deposit never tells the base wallet's owner they were paid.
//
// Nothing touches the network or a database: Horizon and Prisma are in-memory
// fakes injected before the SUT loads, following deposits.jobs.test.js.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

injectMock('config/stellar', () => ({ server: {}, StellarSdk: {} }));
injectMock('common/prisma', () => ({}));
injectMock('services/whatsapp.service', () => ({ sendTextMessage: async () => null }));
injectMock('pricing/pricing.service', () => ({ getExchangeRate: async () => null }));
injectMock('config/env', () => ({
  env: 'test',
  isProduction: false,
  stellar: { network: 'testnet', horizonUrl: '', usdcIssuer: '' },
  messageTransport: 'sim',
}));

const { pollWallet } = require('../src/jobs/deposits.jobs');
const muxedAccounts = require('../src/wallet/muxedAccounts');

// Real SEP-0005 vector account — a valid ed25519 key, published in the spec.
const BASE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const BASE_OWNER_PHONE = '+2349000000001';
const SUB_OWNER_PHONE = '+2349000000077';

const WALLET = Object.freeze({
  id: 'w1',
  userId: 'base-owner',
  publicKey: BASE,
  phoneNumber: BASE_OWNER_PHONE,
  paymentCursor: '1000',
  network: 'testnet',
});

/**
 * Prisma double with the constraints that matter: unique DepositCredit by
 * payment id, and unique outbox by stellarPaymentId.
 */
const makePrisma = ({ subAccounts = [], users = [] } = {}) => {
  const state = {
    wallets: [{ ...WALLET }],
    subAccounts: [...subAccounts],
    credits: [],
    outbox: [],
    users: [...users],
    cursorUpdates: [],
  };

  const client = {
    state,
    wallet: {
      findMany: async () => state.wallets,
      findUnique: async ({ where }) => state.wallets.find((w) => w.id === where.id) || null,
      update: async ({ where, data }) => {
        const w = state.wallets.find((x) => x.id === where.id);
        Object.assign(w, data);
        if (data.paymentCursor) state.cursorUpdates.push(data.paymentCursor);
        return w;
      },
    },
    muxedSubAccount: {
      create: async ({ data }) => {
        const row = { id: `m${state.subAccounts.length + 1}`, ...data };
        state.subAccounts.push(row);
        return row;
      },
      findUnique: async ({ where }) => {
        const { baseAccount, muxedId } = where.baseAccount_muxedId;
        return state.subAccounts.find(
          (r) => r.baseAccount === baseAccount && r.muxedId === muxedId,
        ) || null;
      },
    },
    depositCredit: {
      create: async ({ data }) => {
        if (state.credits.some((c) => c.stellarPaymentId === data.stellarPaymentId)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row = { id: `c${state.credits.length + 1}`, ...data };
        state.credits.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.credits.find((c) => c.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    depositOutboxRecord: {
      upsert: async ({ where, create }) => {
        const found = state.outbox.find((o) => o.stellarPaymentId === where.stellarPaymentId);
        if (found) return found;
        const row = { id: `o${state.outbox.length + 1}`, ...create };
        state.outbox.push(row);
        return row;
      },
      findUnique: async ({ where }) => state.outbox.find(
        (o) => o.stellarPaymentId === where.stellarPaymentId,
      ) || null,
      updateMany: async ({ where, data }) => {
        for (const row of state.outbox) {
          if (row.stellarPaymentId === where.stellarPaymentId) Object.assign(row, data);
        }
        return { count: 1 };
      },
    },
    user: {
      findUnique: async ({ where }) => state.users.find((u) => u.id === where.id) || null,
    },
    $transaction: async (fn) => fn(client),
  };

  return client;
};

/** Horizon double returning one page of the given payment records. */
const makeHorizon = (records) => ({
  payments: () => ({
    forAccount: () => ({
      order: () => ({
        limit: () => ({
          cursor: () => ({ call: async () => ({ records }) }),
          call: async () => ({ records }),
        }),
      }),
    }),
  }),
});

const muxedPayment = (muxedId, over = {}) => ({
  type: 'payment',
  transaction_successful: true,
  paging_token: '1001',
  id: '1001',
  to: BASE,
  to_muxed: muxedAccounts.encodeMuxedAddress({ baseAccount: BASE, muxedId }),
  to_muxed_id: muxedId,
  amount: '25.0000000',
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: TESTNET_USDC,
  ...over,
});

const collectNotifies = () => {
  const sent = [];
  return {
    sent,
    notify: async (phone, message, opts) => {
      sent.push({ phone, message, opts });
      return { messageId: 'wamid.test' };
    },
  };
};

// ── Tests ─────────────────────────────────────────────────────────────────

test('a muxed deposit credits and alerts the SUB-ACCOUNT owner, not the base wallet owner', async () => {
  const prismaClient = makePrisma({
    subAccounts: [{
      id: 'm1', userId: 'alice', walletId: 'w1', muxedId: '77', baseAccount: BASE, network: 'testnet',
    }],
    users: [{ id: 'alice', phoneNumber: SUB_OWNER_PHONE }],
  });
  const { sent, notify } = collectNotifies();

  await pollWallet(WALLET, {
    horizon: makeHorizon([muxedPayment('77')]),
    prismaClient,
    notify,
    fetchRate: async () => null,
  });

  assert.equal(prismaClient.state.credits.length, 1, 'exactly one credit');
  assert.equal(prismaClient.state.credits[0].userId, 'alice');
  assert.equal(prismaClient.state.credits[0].muxedId, '77');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, SUB_OWNER_PHONE, 'the sub-account owner is alerted');
  assert.notEqual(sent[0].phone, BASE_OWNER_PHONE, 'the base wallet owner must NOT be alerted');
  assert.equal(sent[0].opts.notification.userId, 'alice');

  // The outbox row is also addressed to the real owner, so a retry does not
  // later deliver the alert to the wrong person.
  assert.equal(prismaClient.state.outbox[0].phoneNumber, SUB_OWNER_PHONE);
  assert.equal(prismaClient.state.outbox[0].userId, 'alice');
});

test('a sub-account id of 0 with to_muxed_id omitted still routes to its owner', async () => {
  const record = muxedPayment('0');
  delete record.to_muxed_id; // Horizon omits a zero uint64

  const prismaClient = makePrisma({
    subAccounts: [{
      id: 'm0', userId: 'zero-user', walletId: 'w1', muxedId: '0', baseAccount: BASE, network: 'testnet',
    }],
    users: [{ id: 'zero-user', phoneNumber: '+2349000000000' }],
  });
  const { sent, notify } = collectNotifies();

  await pollWallet(WALLET, {
    horizon: makeHorizon([record]), prismaClient, notify, fetchRate: async () => null,
  });

  assert.equal(prismaClient.state.credits.length, 1);
  assert.equal(prismaClient.state.credits[0].userId, 'zero-user');
  assert.equal(prismaClient.state.credits[0].muxedId, '0');
  assert.equal(sent[0].phone, '+2349000000000');
});

test('a plain deposit still credits and alerts the wallet owner unchanged', async () => {
  const prismaClient = makePrisma();
  const { sent, notify } = collectNotifies();

  const record = muxedPayment('1');
  delete record.to_muxed;
  delete record.to_muxed_id;

  await pollWallet(WALLET, {
    horizon: makeHorizon([record]), prismaClient, notify, fetchRate: async () => null,
  });

  assert.equal(prismaClient.state.credits.length, 1);
  assert.equal(prismaClient.state.credits[0].userId, 'base-owner');
  assert.equal(prismaClient.state.credits[0].muxedId, null);
  assert.equal(sent[0].phone, BASE_OWNER_PHONE);
});

test('an unclaimed muxed deposit credits nobody and alerts nobody', async () => {
  // No mapping for id 999: the funds sit on the shared account awaiting
  // operator reconciliation. Telling the base owner they received 25 USDC
  // would be false.
  const prismaClient = makePrisma();
  const { sent, notify } = collectNotifies();

  await pollWallet(WALLET, {
    horizon: makeHorizon([muxedPayment('999')]), prismaClient, notify, fetchRate: async () => null,
  });

  assert.equal(prismaClient.state.credits.length, 0, 'nobody is credited');
  assert.equal(sent.length, 0, 'nobody is alerted');
  // The cursor still advances so the poller does not re-read this payment
  // forever.
  assert.ok(prismaClient.state.cursorUpdates.includes('1001'));
});

test('re-polling the same payment credits once and does not alert twice', async () => {
  const prismaClient = makePrisma({
    subAccounts: [{
      id: 'm1', userId: 'alice', walletId: 'w1', muxedId: '77', baseAccount: BASE, network: 'testnet',
    }],
    users: [{ id: 'alice', phoneNumber: SUB_OWNER_PHONE }],
  });
  const { sent, notify } = collectNotifies();
  const horizon = makeHorizon([muxedPayment('77')]);

  await pollWallet(WALLET, { horizon, prismaClient, notify, fetchRate: async () => null });
  // Replay the identical Horizon page with the cursor rewound, simulating a
  // crash before the cursor was durable, or a second replica.
  await pollWallet({ ...WALLET, paymentCursor: '1000' }, {
    horizon, prismaClient, notify, fetchRate: async () => null,
  });

  assert.equal(prismaClient.state.credits.length, 1, 'credited exactly once');
  assert.equal(sent.length, 1, 'alerted exactly once');
});

test('a crediting failure does not stall the poller or lose the cursor', async () => {
  // Rule 4 of deposits.jobs.js: one failing wallet never stalls the loop.
  const prismaClient = makePrisma({
    subAccounts: [{
      id: 'm1', userId: 'alice', walletId: 'w1', muxedId: '77', baseAccount: BASE, network: 'testnet',
    }],
    users: [{ id: 'alice', phoneNumber: SUB_OWNER_PHONE }],
  });
  prismaClient.depositCredit.create = async () => {
    throw new Error('ledger unavailable');
  };
  const { notify } = collectNotifies();

  await assert.doesNotReject(() => pollWallet(WALLET, {
    horizon: makeHorizon([muxedPayment('77')]),
    prismaClient,
    notify,
    fetchRate: async () => null,
  }));

  assert.ok(
    prismaClient.state.cursorUpdates.includes('1001'),
    'the cursor still advances so the sweep makes progress',
  );
});

test('an untrusted issuer is not credited, and is alerted as unverified', async () => {
  const prismaClient = makePrisma();
  const { sent, notify } = collectNotifies();

  const record = muxedPayment('1', { asset_issuer: 'GAQAA5L65LSYH7CQ3VTJ7F3HHNTNCQIKEO7YPC2FUYAKQNRFAWSFTNZK' });
  delete record.to_muxed;
  delete record.to_muxed_id;

  await pollWallet(WALLET, {
    horizon: makeHorizon([record]), prismaClient, notify, fetchRate: async () => null,
  });

  assert.equal(prismaClient.state.credits.length, 0, 'an unrecognised issuer is never credited');
  // The existing #285 behaviour is preserved: the user is still warned, but
  // the message does not imply the asset is the real, valued one.
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /unrecognized issuer/);
  assert.equal(sent[0].opts.notification.type, 'unverified_asset_received');
});
