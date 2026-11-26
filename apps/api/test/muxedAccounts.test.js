// Unit tests for Stellar muxed account (MED25519) routing (#958).
//
// The guarantees under test:
//
//   * a 64-bit sub-account id survives encode/decode EXACTLY — including ids
//     beyond Number.MAX_SAFE_INTEGER, where Number() would corrupt them;
//   * a muxed deposit credits the sub-account's owner, not the base wallet's;
//   * `to_muxed` present with `to_muxed_id` absent means sub-account 0, which
//     is a real sub-account and not "no sub-account";
//   * an unknown sub-account id credits NOBODY — never the base owner;
//   * the same Horizon payment can never be credited twice;
//   * a sub-account is never treated as separately funded or trustlined.
//
// Everything is offline: Prisma and the ledger are injected fakes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const StellarSdk = require('@stellar/stellar-sdk');
const muxed = require('../src/wallet/muxedAccounts');

// A real, valid ed25519 account from the SEP-0005 public test vectors — safe
// to commit, it is published in the Stellar protocol spec.
const BASE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const OTHER_BASE = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';

// Configured testnet USDC issuer (network profiles) and a spoof.
const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const SPOOF_ISSUER = 'GAQAA5L65LSYH7CQ3VTJ7F3HHNTNCQIKEO7YPC2FUYAKQNRFAWSFTNZK';

const MAX_ID = '18446744073709551615';

// ── Fakes ─────────────────────────────────────────────────────────────────

/**
 * Minimal in-memory Prisma double. Enforces the two unique constraints the
 * production schema declares, because those constraints ARE the correctness
 * mechanism being tested.
 */
const makePrisma = ({ subAccounts = [], users = [], withLedger = false } = {}) => {
  const state = {
    subAccounts: [...subAccounts],
    credits: [],
    journalEntries: [],
    users: [...users],
  };

  const client = {
    state,
    muxedSubAccount: {
      create: async ({ data }) => {
        const clash = state.subAccounts.find(
          (r) => r.baseAccount === data.baseAccount && r.muxedId === data.muxedId,
        );
        if (clash) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        const row = { id: `mux_${state.subAccounts.length + 1}`, ...data };
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
        const row = { id: `cr_${state.credits.length + 1}`, ...data };
        state.credits.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = state.credits.find((c) => c.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    user: {
      findUnique: async ({ where }) => state.users.find((u) => u.id === where.id) || null,
    },
    $transaction: async (fn) => fn(client),
  };

  if (withLedger) {
    client.journalEntry = {};
    client.ledgerAccount = {};
    client.ledgerPosting = {};
  }

  return client;
};

const makeLedger = (state) => ({
  createJournalEntry: async (args) => {
    state.calls.push(args);
    return { id: `je_${state.calls.length}` };
  },
});

const paymentRecord = (over = {}) => ({
  type: 'payment',
  transaction_successful: true,
  paging_token: '1001',
  to: BASE,
  amount: '25.0000000',
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: TESTNET_USDC,
  ...over,
});

const WALLET = Object.freeze({
  id: 'w1',
  userId: 'base-owner',
  publicKey: BASE,
  phoneNumber: '+2348000000001',
  network: 'testnet',
});

// ── Address round-trips and 64-bit precision ──────────────────────────────

test('encode/decode round-trips every id exactly, including the 64-bit ceiling', () => {
  for (const id of ['0', '1', '42', '1234567890123456789', MAX_ID]) {
    const address = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: id });
    assert.ok(address.startsWith('M'), `${id} should encode to an M address`);
    assert.ok(StellarSdk.StrKey.isValidMed25519PublicKey(address));

    const decoded = muxed.decodeMuxedAddress(address);
    assert.equal(decoded.baseAccount, BASE);
    assert.equal(decoded.muxedId, id, `${id} must survive the round-trip exactly`);

    // Re-encoding the decoded parts must reproduce the identical address.
    assert.equal(
      muxed.encodeMuxedAddress({ baseAccount: decoded.baseAccount, muxedId: decoded.muxedId }),
      address,
    );
  }
});

test('the 64-bit ceiling is beyond Number precision, and the module keeps it exact', () => {
  // Establish the hazard: this is why ids are strings/BigInt throughout.
  assert.ok(BigInt(MAX_ID) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.notEqual(String(Number(MAX_ID)), MAX_ID, 'Number() must be shown to corrupt this id');

  const address = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: MAX_ID });
  assert.equal(muxed.decodeMuxedAddress(address).muxedId, MAX_ID);

  // BigInt input is accepted and normalised identically.
  assert.equal(muxed.normalizeMuxedId(BigInt(MAX_ID)), MAX_ID);
});

test('distinct ids on one base account produce distinct addresses', () => {
  const a = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '1' });
  const b = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '2' });
  assert.notEqual(a, b);
  // ...and the same id on different base accounts also differs.
  const c = muxed.encodeMuxedAddress({ baseAccount: OTHER_BASE, muxedId: '1' });
  assert.notEqual(a, c);
});

// ── Rejections ────────────────────────────────────────────────────────────

test('normalizeMuxedId rejects every value that cannot be an exact uint64', () => {
  const bad = [
    [-1n, 'negative bigint'],
    ['-1', 'negative string'],
    ['18446744073709551616', 'one past the 64-bit max'],
    ['1.5', 'non-integer string'],
    ['1e3', 'exponential string'],
    ['0x10', 'hex string'],
    ['+1', 'signed string'],
    ['', 'empty string'],
    ['  ', 'whitespace'],
    ['abc', 'non-numeric'],
    [1.5, 'non-integer number'],
    [Number.MAX_SAFE_INTEGER + 2, 'unsafe number that already lost precision'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'object'],
  ];

  for (const [value, label] of bad) {
    assert.throws(
      () => muxed.normalizeMuxedId(value),
      (err) => err.code === 'invalid_muxed_id',
      `${label} must be rejected with invalid_muxed_id`,
    );
  }
});

test('MAX_MUXED_ID is exactly 2^64 - 1 and is accepted at the boundary', () => {
  assert.equal(muxed.MAX_MUXED_ID, 2n ** 64n - 1n);
  assert.equal(muxed.normalizeMuxedId(muxed.MAX_MUXED_ID), MAX_ID);
});

test('decodeMuxedAddress rejects anything that is not a valid M address', () => {
  const bad = [BASE, 'MINVALID', '', 'not-an-address', null, 42];
  for (const value of bad) {
    assert.throws(
      () => muxed.decodeMuxedAddress(value),
      (err) => err.code === 'invalid_muxed_address',
      `${String(value)} must be rejected`,
    );
  }

  // A well-formed M address with a corrupted checksum character.
  const valid = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '7' });
  const corrupted = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(
    () => muxed.decodeMuxedAddress(corrupted),
    (err) => err.code === 'invalid_muxed_address',
  );
});

test('muxed addresses cannot be nested or built on a non-account', () => {
  const nested = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '1' });
  assert.throws(
    () => muxed.encodeMuxedAddress({ baseAccount: nested, muxedId: '2' }),
    (err) => err.code === 'invalid_base_account',
  );
  for (const value of ['', 'GBAD', null, 123]) {
    assert.throws(
      () => muxed.encodeMuxedAddress({ baseAccount: value, muxedId: '1' }),
      (err) => err.code === 'invalid_base_account',
    );
  }
});

// ── Horizon record interpretation ─────────────────────────────────────────

test('a non-muxed payment reports isMuxed false with no id', () => {
  const d = muxed.describeIncomingPayment(paymentRecord());
  assert.equal(d.isMuxed, false);
  assert.equal(d.muxedId, null);
  assert.equal(d.baseAccount, BASE);
  assert.equal(d.paymentId, '1001');
});

test('to_muxed_id arrives as a STRING and is read without precision loss', () => {
  const address = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: MAX_ID });
  const d = muxed.describeIncomingPayment(paymentRecord({
    to_muxed: address,
    to_muxed_id: MAX_ID, // Horizon's `,string` tag: a JSON string
  }));
  assert.equal(d.isMuxed, true);
  assert.equal(d.muxedId, MAX_ID);
});

test('to_muxed present with to_muxed_id ABSENT means sub-account 0, not "no sub-account"', () => {
  // Horizon's `omitempty` on a uint64 drops the field when the id is zero.
  const address = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '0' });
  const d = muxed.describeIncomingPayment(paymentRecord({ to_muxed: address }));
  assert.equal(d.isMuxed, true, 'presence of to_muxed is what marks a muxed payment');
  assert.equal(d.muxedId, '0', 'the omitted id is zero — a real sub-account');
});

test('an unsafe numeric to_muxed_id is refused rather than silently misrouted', () => {
  const address = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '1' });
  assert.throws(
    () => muxed.describeIncomingPayment(paymentRecord({
      to_muxed: address,
      to_muxed_id: Number.MAX_SAFE_INTEGER + 2,
    })),
    (err) => err.code === 'invalid_muxed_id',
  );
});

// ── Sub-account assignment ────────────────────────────────────────────────

test('assignSubAccount persists the mapping and derives its address', async () => {
  const prisma = makePrisma();
  const row = await muxed.assignSubAccount({
    userId: 'u1', wallet: WALLET, muxedId: '9', prismaClient: prisma, network: 'testnet',
  });

  assert.equal(row.userId, 'u1');
  assert.equal(row.muxedId, '9');
  assert.equal(row.baseAccount, BASE);
  assert.equal(row.address, muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '9' }));
  assert.equal(prisma.state.subAccounts.length, 1);
});

test('assignSubAccount is idempotent: a lost insert race returns the existing row', async () => {
  const prisma = makePrisma();
  const first = await muxed.assignSubAccount({
    userId: 'u1', wallet: WALLET, muxedId: '5', prismaClient: prisma, network: 'testnet',
  });
  const second = await muxed.assignSubAccount({
    userId: 'u1', wallet: WALLET, muxedId: '5', prismaClient: prisma, network: 'testnet',
  });

  assert.equal(second.id, first.id);
  assert.equal(prisma.state.subAccounts.length, 1, 'no duplicate mapping row');
});

test('a sub-account is never funded and never gets its own trustline', async () => {
  // The core conceptual guarantee of muxed accounts: sub-accounts share the
  // underlying account's reserve and trustlines. Assignment must therefore be
  // a pure database write — any funding or trustline call would be a bug.
  const prisma = makePrisma();
  const forbidden = [];
  prisma.wallet = {
    update: async () => { forbidden.push('wallet.update'); },
  };

  await muxed.assignSubAccount({
    userId: 'u1', wallet: WALLET, muxedId: '3', prismaClient: prisma, network: 'testnet',
  });

  assert.deepEqual(forbidden, [], 'assignSubAccount must not touch wallet funding state');
  // The mapping row itself carries no balance, reserve or trustline field.
  const row = prisma.state.subAccounts[0];
  for (const field of ['balance', 'funded', 'fundingState', 'trustlineState', 'reserve']) {
    assert.equal(row[field], undefined, `sub-account must not carry a ${field}`);
  }
});

// ── Routing and accounting ────────────────────────────────────────────────

test('a muxed deposit credits the SUB-ACCOUNT owner, not the base wallet owner', async () => {
  const address = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '77' });
  const prisma = makePrisma({
    subAccounts: [{ id: 'm1', userId: 'alice', walletId: 'w1', muxedId: '77', baseAccount: BASE, network: 'testnet' }],
  });

  const result = await muxed.creditDeposit({
    record: paymentRecord({ to_muxed: address, to_muxed_id: '77' }),
    wallet: WALLET,
    prismaClient: prisma,
    network: 'testnet',
  });

  assert.equal(result.credited, true);
  assert.equal(result.userId, 'alice');
  assert.notEqual(result.userId, WALLET.userId, 'must not credit the base account owner');
  assert.equal(result.muxedId, '77');
  assert.equal(prisma.state.credits[0].amount, '25.0000000');
});

test('sub-account 0 (omitted to_muxed_id) credits the right owner', async () => {
  const address = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '0' });
  const prisma = makePrisma({
    subAccounts: [{ id: 'm0', userId: 'zero-user', walletId: 'w1', muxedId: '0', baseAccount: BASE, network: 'testnet' }],
  });

  const result = await muxed.creditDeposit({
    record: paymentRecord({ to_muxed: address }),
    wallet: WALLET,
    prismaClient: prisma,
    network: 'testnet',
  });

  assert.equal(result.credited, true);
  assert.equal(result.userId, 'zero-user');
  assert.equal(result.muxedId, '0');
});

test('a plain (non-muxed) deposit credits the wallet owner', async () => {
  const prisma = makePrisma();
  const result = await muxed.creditDeposit({
    record: paymentRecord(), wallet: WALLET, prismaClient: prisma, network: 'testnet',
  });

  assert.equal(result.credited, true);
  assert.equal(result.userId, 'base-owner');
  assert.equal(result.muxedId, null);
});

test('an UNKNOWN sub-account id credits nobody — least of all the base owner', async () => {
  const address = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '999' });
  const prisma = makePrisma(); // no mappings at all

  const result = await muxed.creditDeposit({
    record: paymentRecord({ to_muxed: address, to_muxed_id: '999' }),
    wallet: WALLET,
    prismaClient: prisma,
    network: 'testnet',
  });

  assert.equal(result.credited, false);
  assert.equal(result.reason, muxed.DECLINE_REASONS.UNKNOWN_SUB_ACCOUNT);
  assert.equal(result.muxedId, '999');
  assert.equal(prisma.state.credits.length, 0, 'no credit row may be written');
});

test('resolveSubAccount returns null for unknown and malformed ids without throwing', async () => {
  const prisma = makePrisma();
  assert.equal(await muxed.resolveSubAccount({ baseAccount: BASE, muxedId: '1', prismaClient: prisma }), null);
  assert.equal(await muxed.resolveSubAccount({ baseAccount: BASE, muxedId: 'nonsense', prismaClient: prisma }), null);
});

// ── Exactly-once crediting ────────────────────────────────────────────────

test('the same Horizon payment is credited exactly once', async () => {
  const address = muxed.encodeMuxedAddress({ baseAccount: BASE, muxedId: '77' });
  const prisma = makePrisma({
    subAccounts: [{ id: 'm1', userId: 'alice', walletId: 'w1', muxedId: '77', baseAccount: BASE, network: 'testnet' }],
    withLedger: true,
  });
  const ledgerState = { calls: [] };
  const ledger = makeLedger(ledgerState);
  const record = paymentRecord({ to_muxed: address, to_muxed_id: '77' });

  const first = await muxed.creditDeposit({
    record, wallet: WALLET, prismaClient: prisma, network: 'testnet', ledger,
  });
  const second = await muxed.creditDeposit({
    record, wallet: WALLET, prismaClient: prisma, network: 'testnet', ledger,
  });

  assert.equal(first.credited, true);
  assert.equal(second.credited, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.reason, muxed.DECLINE_REASONS.DUPLICATE);
  assert.equal(prisma.state.credits.length, 1, 'exactly one credit row');
  assert.equal(ledgerState.calls.length, 1, 'the ledger must be posted exactly once');
});

test('the deposit ledger posting is balanced and keyed to the payment', async () => {
  const prisma = makePrisma({ withLedger: true });
  const ledgerState = { calls: [] };

  await muxed.creditDeposit({
    record: paymentRecord(),
    wallet: WALLET,
    prismaClient: prisma,
    network: 'testnet',
    ledger: makeLedger(ledgerState),
  });

  const [call] = ledgerState.calls;
  assert.equal(call.eventType, 'deposit.credited');
  assert.equal(call.externalRef, '1001', 'keyed to the Horizon payment id');
  // Real balance check via the production ledger validator.
  const { assertBalancedPostings } = require('../src/payment/ledger.service');
  assert.equal(assertBalancedPostings(call.postings), true);
  const credited = call.postings.find((p) => p.type === 'customer_money');
  assert.equal(credited.userId, 'base-owner');
  assert.equal(credited.amount, '25.0000000');
});

// ── Validation refusals ───────────────────────────────────────────────────

test('a payment to a DIFFERENT account is refused', async () => {
  const prisma = makePrisma();
  const result = await muxed.creditDeposit({
    record: paymentRecord({ to: OTHER_BASE }),
    wallet: WALLET,
    prismaClient: prisma,
    network: 'testnet',
  });
  assert.equal(result.credited, false);
  assert.equal(result.reason, muxed.DECLINE_REASONS.WRONG_DESTINATION);
  assert.equal(prisma.state.credits.length, 0);
});

test('a failed transaction is never credited', async () => {
  const prisma = makePrisma();
  const result = await muxed.creditDeposit({
    record: paymentRecord({ transaction_successful: false }),
    wallet: WALLET,
    prismaClient: prisma,
    network: 'testnet',
  });
  assert.equal(result.credited, false);
  assert.equal(result.reason, muxed.DECLINE_REASONS.FAILED_TRANSACTION);
});

test('a non-payment operation is never credited', async () => {
  const prisma = makePrisma();
  for (const type of ['create_account', 'change_trust', 'account_merge']) {
    const result = await muxed.creditDeposit({
      record: paymentRecord({ type }), wallet: WALLET, prismaClient: prisma, network: 'testnet',
    });
    assert.equal(result.credited, false);
    assert.equal(result.reason, muxed.DECLINE_REASONS.NOT_A_PAYMENT);
  }
});

test('an untrusted asset issuer is never credited, even with the right code', async () => {
  const prisma = makePrisma();
  const result = await muxed.creditDeposit({
    record: paymentRecord({ asset_issuer: SPOOF_ISSUER }),
    wallet: WALLET,
    prismaClient: prisma,
    network: 'testnet',
  });
  assert.equal(result.credited, false);
  assert.equal(result.reason, muxed.DECLINE_REASONS.UNTRUSTED_ASSET);
  assert.equal(prisma.state.credits.length, 0);
});

test('a wallet from another network is never credited against this ledger', async () => {
  const prisma = makePrisma();
  const result = await muxed.creditDeposit({
    record: paymentRecord(),
    wallet: { ...WALLET, network: 'public' },
    prismaClient: prisma,
    network: 'testnet',
  });
  assert.equal(result.credited, false);
  assert.equal(result.reason, muxed.DECLINE_REASONS.NETWORK_MISMATCH);
});

// ── Notification targeting ────────────────────────────────────────────────

test('a muxed deposit notifies the sub-account owner, not the base wallet owner', async () => {
  const prisma = makePrisma({ users: [{ id: 'alice', phoneNumber: '+2348000000099' }] });
  const target = await muxed.resolveNotificationTarget({
    userId: 'alice', wallet: WALLET, prismaClient: prisma,
  });
  assert.equal(target, '+2348000000099');
  assert.notEqual(target, WALLET.phoneNumber);
});

test('notification falls back to the wallet number for its own owner', async () => {
  const prisma = makePrisma();
  const target = await muxed.resolveNotificationTarget({
    userId: 'base-owner', wallet: WALLET, prismaClient: prisma,
  });
  assert.equal(target, WALLET.phoneNumber);
});
