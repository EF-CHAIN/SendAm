'use strict';

// #959, failure side: when the quorum gate refuses a transaction, nothing may
// be left half-done.
//
// `payment.orchestrator.test.js` already proves that an adapter failure marks
// the row failed and rethrows. These tests prove the same for the NEW class of
// failure the gate introduces — a refusal that happens AFTER the velocity
// reservation was taken and AFTER the row was written as `processing`, but
// BEFORE any envelope existed:
//
//   * the caller sees the gate's own error code, not a generic wrapper;
//   * the row is marked failed exactly once, and is never advanced to pending;
//   * the ledger's failed entry is posted only after the row is failed;
//   * the reservation reversal is delegated to the failure engine, which owns
//     the reversal job;
//   * the reversal job failing cannot mask the original refusal.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relativeFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    exports: factory(),
  };
};

const mocks = {
  validateAddress: mock.fn(),
  enforceTransactionPolicy: mock.fn(),
  createQuote: mock.fn(),
  validateQuoteForExecution: mock.fn(),
  requote: mock.fn(),
  createOrGetWallet: mock.fn(),
  submitPayment: mock.fn(),
  writeAuditLog: mock.fn(),
  markTransactionFailed: mock.fn(),
  withIdAlias: mock.fn((x) => x),
  prismaTxCreate: mock.fn(),
  prismaTxUpdate: mock.fn(),
  prismaTxFindUnique: mock.fn(),
  prismaQuoteCreate: mock.fn(),
  prismaQuoteFindUnique: mock.fn(),
  prismaQuoteUpdate: mock.fn(),
  screenPaymentParties: mock.fn(),
  evaluateTransactionRisk: mock.fn(),
  assertRiskAllowsPayment: mock.fn(),
  enforceVelocityLimit: mock.fn(),
  releaseVelocityReservation: mock.fn(),
  transitionPaymentState: mock.fn(),
  handleStellarPaymentFailure: mock.fn(),
  postPaymentSettled: mock.fn(),
  postPaymentFailed: mock.fn(),
  QUOTE_STATUS: { ACTIVE: 'active', CONSUMED: 'consumed', EXPIRED: 'expired', REPLACED: 'replaced', ORPHANED: 'orphaned' },
};

const resetMockCalls = () => {
  for (const fn of Object.values(mocks)) fn.mock?.resetCalls?.();
};

const txMock = {
  transaction: {
    create: mocks.prismaTxCreate,
    update: mocks.prismaTxUpdate,
    updateMany: async (args) => {
      mocks.prismaTxUpdate(args);
      return { count: 1 };
    },
    findUnique: mocks.prismaTxFindUnique,
  },
  quote: {
    create: mocks.prismaQuoteCreate,
    findUnique: mocks.prismaQuoteFindUnique,
    update: mocks.prismaQuoteUpdate,
  },
};

// Modules the quorum test must control, on top of the standard orchestrator
// seams. Injected BEFORE the SUT is required.
injectMock('wallet/stellar.adapter', () => ({ validateAddress: mocks.validateAddress }));
injectMock('compliance/compliance.service', () => ({ enforceTransactionPolicy: mocks.enforceTransactionPolicy }));
injectMock('config/env', () => ({ stellar: { network: 'testnet' } }));
injectMock('pricing/pricing.service', () => ({
  createQuote: mocks.createQuote,
  validateQuoteForExecution: mocks.validateQuoteForExecution,
  requote: mocks.requote,
  QUOTE_STATUS: mocks.QUOTE_STATUS,
}));
injectMock('wallet/wallet.service', () => ({
  createOrGetWallet: mocks.createOrGetWallet,
  submitPayment: mocks.submitPayment,
}));
injectMock('common/audit.service', () => ({ writeAuditLog: mocks.writeAuditLog }));
injectMock('payment/markFailed', () => ({ markTransactionFailed: mocks.markTransactionFailed }));
injectMock('common/records', () => ({ withIdAlias: mocks.withIdAlias }));
injectMock('common/prisma', () => ({
  $transaction: async (fn) => fn(txMock),
  transaction: txMock.transaction,
  quote: txMock.quote,
}));
injectMock('compliance/sanctionsScreening', () => ({ screenPaymentParties: mocks.screenPaymentParties }));
injectMock('compliance/riskEngine', () => ({
  evaluateTransactionRisk: mocks.evaluateTransactionRisk,
  assertRiskAllowsPayment: mocks.assertRiskAllowsPayment,
}));
injectMock('compliance/velocityLimits', () => ({
  enforceVelocityLimit: mocks.enforceVelocityLimit,
  releaseVelocityReservation: mocks.releaseVelocityReservation,
}));
injectMock('payment/payment.transitions', () => ({ transitionPaymentState: mocks.transitionPaymentState }));
injectMock('payment/refundEngine', () => ({ handleStellarPaymentFailure: mocks.handleStellarPaymentFailure }));
injectMock('payment/ledger.service', () => ({
  postPaymentSettled: mocks.postPaymentSettled,
  postPaymentFailed: mocks.postPaymentFailed,
}));

const { executePayment } = require('../src/payment/payment.orchestrator');

const sender = { id: 1, phoneNumber: '+2348000000001', status: 'active' };
const destination = 'GCXQJ7E6C6TQX7GVV3T6HX3Q7H3P6G6X7Q7J7E6C6TQX7GVV3T6HX3Q7';
const baseInput = {
  sender,
  recipientPhoneNumber: '+2348000000002',
  destination,
  amount: '1500.0000000',
  asset: 'XLM',
};

const policySnapshot = {
  referenceCurrency: 'NGN',
  sourceAsset: 'XLM',
  sourceAmount: '1500.0000000',
  rate: '1550.00',
  convertedAmount: '2325000.00',
  source: 'exchangerate-api',
  fetchedAt: '2026-08-28T09:00:00.000Z',
  maxAgeMs: 300000,
  policyVersion: '1',
};

const txRow = {
  id: 'tx_1',
  userId: 1,
  type: 'send',
  amount: '1500.0000000',
  asset: 'XLM',
  rail: 'stellar',
  status: 'processing',
  fiatCurrency: 'NGN',
  fiatAmount: '2325000.00',
  metadata: {},
};
const wallet = { id: 'wallet_1', publicKey: destination, encryptedSecretKey: 'encrypted' };
const quote = { id: 'quote_1', status: 'active' };

let currentTx;

// The refusal the gate actually produces — a real COSIGNER_ERROR_CODES value,
// so the assertions cannot accidentally match a generic Error.
const quorumRefusal = (code = 'cosigner_unavailable') => Object.assign(
  new Error(
    'High-value transfer refused: no quorum co-signer is configured, so a second '
    + 'signature can never be obtained.',
  ),
  // `preSubmission` is what the gate itself attaches (multisig.js
  // #authorizeForSubmission): the refusal happened after submission was
  // entered but before any envelope reached Horizon.
  { code, statusCode: 409, preSubmission: true },
);

// Ordered record of every piece of bookkeeping, so "after" is proven rather
// than assumed.
let bookkeeping;

const setUp = () => {
  resetMockCalls();
  currentTx = { ...txRow };
  bookkeeping = [];

  mocks.validateAddress.mock.mockImplementation(() => true);
  mocks.screenPaymentParties.mock.mockImplementation(async () => {});
  mocks.evaluateTransactionRisk.mock.mockImplementation(async () => ({ riskScore: 10 }));
  mocks.assertRiskAllowsPayment.mock.mockImplementation(() => {});
  mocks.enforceTransactionPolicy.mock.mockImplementation(() => ({
    profile: { tier: 2 },
    policySnapshot,
    riskScore: 10,
  }));
  mocks.enforceVelocityLimit.mock.mockImplementation(async () => {
    bookkeeping.push('velocity.reserved');
    return { reservationId: 'res_1' };
  });
  mocks.createQuote.mock.mockImplementation(() => quote);
  mocks.validateQuoteForExecution.mock.mockImplementation(() => quote);
  mocks.createOrGetWallet.mock.mockImplementation(() => wallet);
  mocks.prismaTxCreate.mock.mockImplementation(() => currentTx);
  mocks.prismaTxFindUnique.mock.mockImplementation(({ where }) => {
    if (where?.id === 'tx_1' || where?.id === currentTx.id) return currentTx;
    return null;
  });
  mocks.prismaTxUpdate.mock.mockImplementation((args) => {
    currentTx = { ...currentTx, ...(args.data || {}) };
    return currentTx;
  });
  mocks.transitionPaymentState.mock.mockImplementation(async () => {
    bookkeeping.push('pending');
    return { ...currentTx, status: 'pending' };
  });
  mocks.markTransactionFailed.mock.mockImplementation(async () => {
    bookkeeping.push('failed');
    currentTx = { ...currentTx, status: 'failed' };
  });
  mocks.postPaymentFailed.mock.mockImplementation(async () => { bookkeeping.push('ledger.failed'); });
  mocks.postPaymentSettled.mock.mockImplementation(async () => { bookkeeping.push('ledger.settled'); });
  // Both of these are `async` in the real modules (refundEngine.js,
  // velocityLimits.js) and the orchestrator chains `.catch()` onto their
  // return value, so the mocks must return promises too.
  mocks.handleStellarPaymentFailure.mock.mockImplementation(async () => { bookkeeping.push('refund.engine'); });
  mocks.releaseVelocityReservation.mock.mockImplementation(async () => { bookkeeping.push('velocity.released'); });
  mocks.writeAuditLog.mock.mockImplementation(() => {});
};

const runRefused = async (code) => {
  setUp();
  const refusal = quorumRefusal(code);
  mocks.submitPayment.mock.mockImplementation(async () => { throw refusal; });

  let thrown;
  try {
    await executePayment(baseInput);
  } catch (error) {
    thrown = error;
  }
  return { refusal, thrown };
};

test('a quorum refusal reaches the caller with its OWN code, not a wrapper', async () => {
  const { refusal, thrown } = await runRefused();

  assert.equal(thrown, refusal, 'the identical error object must reach the caller');
  assert.equal(thrown.code, 'cosigner_unavailable');
  assert.equal(thrown.statusCode, 409, 'the refusal keeps its status, so no route can 200 it');
});

test('the velocity reservation was taken, then the row written — the refusal lands after both', async () => {
  await runRefused();

  // This is what makes the failure path matter: by the time the gate refuses,
  // there is real accounting to unwind.
  assert.ok(bookkeeping.includes('velocity.reserved'));
  assert.equal(mocks.prismaTxCreate.mock.callCount(), 1);
});

test('a quorum refusal marks the transaction failed exactly once, with the refusal attached', async () => {
  const { refusal, thrown } = await runRefused();

  assert.equal(thrown, refusal, 'the refusal still propagates');
  assert.equal(mocks.markTransactionFailed.mock.callCount(), 1);
  const call = mocks.markTransactionFailed.mock.calls[0].arguments[0];
  assert.equal(call.transactionId, 'tx_1');
  assert.equal(call.error, refusal);
  assert.equal(call.error.code, 'cosigner_unavailable');
  assert.equal(currentTx.status, 'failed', 'the row does not stay in `processing` forever');
});

test('a quorum refusal never advances the transaction to pending', async () => {
  await runRefused();

  assert.equal(mocks.transitionPaymentState.mock.callCount(), 0);
  assert.equal(mocks.postPaymentSettled.mock.callCount(), 0);
  assert.equal(mocks.prismaTxUpdate.mock.callCount(), 0, 'no txHash is written for an envelope that never existed');
  assert.equal(bookkeeping.includes('pending'), false);
  assert.equal(bookkeeping.includes('ledger.settled'), false);
});

test('the failed ledger entry is posted only after the row is marked failed', async () => {
  await runRefused();

  const failedAt = bookkeeping.indexOf('failed');
  const ledgerAt = bookkeeping.indexOf('ledger.failed');

  assert.ok(failedAt !== -1, 'the row must be marked failed');
  assert.ok(ledgerAt !== -1, 'the failed entry must be posted');
  assert.ok(
    ledgerAt > failedAt,
    `accounting must see the failed row first; order was ${JSON.stringify(bookkeeping)}`,
  );
});

test('a quorum refusal releases the velocity reservation instead of leaking it', async () => {
  const { refusal } = await runRefused();

  // The refusal is raised from inside `submitPayment`, so `submissionStarted`
  // is already true — but nothing reached Horizon, so the reservation is the
  // orchestrator's to release. It cannot be left to the reversal job:
  // `handleStellarPaymentFailure` classifies a non-Horizon error as "not a
  // Stellar failure" and enqueues nothing, so a reservation left to it is
  // leaked until it expires. `preSubmission` on the refusal is what tells the
  // orchestrator which of the two it is.
  assert.equal(
    mocks.releaseVelocityReservation.mock.callCount(),
    1,
    'the reservation taken for a transfer that never left the process must be given back',
  );
  assert.equal(mocks.releaseVelocityReservation.mock.calls[0].arguments[0].reservationId, 'res_1');

  // The failure engine is still notified — it is the single place that owns
  // the reversal job — and receives the full context.
  assert.equal(mocks.handleStellarPaymentFailure.mock.callCount(), 1);
  const args = mocks.handleStellarPaymentFailure.mock.calls[0].arguments[0];
  assert.equal(args.transaction.id, 'tx_1');
  assert.equal(args.error, refusal);
});

test('a post-submission failure does NOT release the reservation locally', async () => {
  setUp();
  // No `preSubmission` tag: the envelope may be on the network, so only the
  // reversal job may decide what to give back.
  const horizonFailure = Object.assign(new Error('tx_failed'), {
    response: { data: { extras: { result_codes: { transaction: 'tx_failed' } } } },
  });
  mocks.submitPayment.mock.mockImplementation(async () => { throw horizonFailure; });

  await assert.rejects(() => executePayment(baseInput), { message: 'tx_failed' });

  assert.equal(mocks.releaseVelocityReservation.mock.callCount(), 0);
  assert.equal(mocks.handleStellarPaymentFailure.mock.callCount(), 1);
});

test('a failing reversal job cannot mask the original refusal', async () => {
  setUp();
  const refusal = quorumRefusal('invalid_cosigner_signature');
  mocks.submitPayment.mock.mockImplementation(async () => { throw refusal; });
  mocks.handleStellarPaymentFailure.mock.mockImplementation(async () => {
    throw new Error('reversal job is down');
  });

  const thrown = await executePayment(baseInput).then(
    () => assert.fail('the payment must not resolve after a quorum refusal'),
    (error) => error,
  );

  assert.equal(thrown, refusal, 'the caller must still see why the payment was refused');
  assert.equal(thrown.code, 'invalid_cosigner_signature');
});

test('a refusal before submission started still releases the reservation directly', async () => {
  setUp();
  // Wallet creation is the step before `submissionStarted = true`.
  mocks.createOrGetWallet.mock.mockImplementation(async () => { throw new Error('wallet unavailable'); });

  await assert.rejects(() => executePayment(baseInput), { message: 'wallet unavailable' });

  assert.equal(mocks.releaseVelocityReservation.mock.callCount(), 1);
  // The failure engine is still notified — it is the single place that owns
  // the reversal job — but here the orchestrator has already released the
  // reservation itself, because nothing had been submitted.
  assert.equal(mocks.handleStellarPaymentFailure.mock.callCount(), 1);
});
