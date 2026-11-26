// In-situ transfer-flow wiring for trustline auto-establishment (#962).
//
// `trustlines.transfer.test.js` proves the pre-transfer hook behaves. This
// file proves `executePayment` actually CALLS it, with the right asset, at the
// right moment, and reacts correctly:
//
//   * the hook runs BEFORE submission, never after;
//   * it is handed the asset the RECIPIENT receives -- the destination asset
//     on a path payment, not the asset being sent;
//   * when the trustline cannot be established nothing is submitted, and the
//     transaction is marked failed with the velocity reservation released --
//     the existing accounting path, not a new one;
//   * native XLM transfers still submit with no trustline work.
//
// Every collaborator is a require.cache mock, following the technique already
// used by payment.orchestrator.test.js. Nothing touches a network or database.
//
// NOTE ON SCOPE: this file deliberately builds its own complete mock set
// rather than extending payment.orchestrator.test.js, whose harness is stale
// against upstream main and whose 14 executePayment tests fail there before
// any change of ours (`Cannot read properties of undefined (reading
// 'findUnique')`). Repairing that harness is an unrelated upstream fix.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relativeFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

const DEST = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

const calls = {
  ensureTrustline: [],
  submitPayment: [],
  markFailed: [],
  releaseReservation: [],
  order: [],
};

let trustlineOutcome = { required: true, custodied: true, established: true, submitted: false, alreadyExisted: true };
let trustlineError = null;

let currentTx = {
  id: 'tx_1', userId: 1, type: 'send', amount: '100.0000000', asset: 'USDC',
  rail: 'stellar', status: 'processing', metadata: {},
};

// ── Collaborator mocks ──────────────────────────────────────────────────────

injectMock('wallet/trustlines', () => ({
  TRUSTLINE_STATUS: { PENDING: 'pending', SUBMITTED: 'submitted', ESTABLISHED: 'established', FAILED: 'failed' },
  TRUSTLINE_ERROR_CODES: {
    INSUFFICIENT_RESERVE: 'insufficient_reserve',
    NOT_CUSTODIED: 'recipient_not_custodied',
    NO_SIGNER: 'no_signer',
  },
  createChangeTrustSubmitter: () => ({ buildAndSign: async () => ({}), submit: async () => ({ hash: 'h' }) }),
  ensureTrustlineForIncomingTransfer: async (args) => {
    calls.ensureTrustline.push(args);
    calls.order.push('trustline');
    if (trustlineError) throw trustlineError;
    return trustlineOutcome;
  },
}));

injectMock('wallet/wallet.service', () => ({
  createOrGetWallet: async () => ({ id: 'wallet_1', publicKey: DEST, encryptedSecretKey: 'enc' }),
  submitPayment: async (args) => {
    calls.submitPayment.push(args);
    calls.order.push('submit');
    return { txHash: 'abc123', explorerUrl: 'https://stellar.expert/abc123' };
  },
  signWithWallet: async ({ transaction }) => transaction,
}));

injectMock('wallet/stellar.adapter', () => ({
  validateAddress: () => true,
  isMuxedAddress: () => false,
  validateMemo: () => true,
  redactMemo: (m) => String(m),
  resolveAsset: () => ({ getIssuer: () => 'GISSUER', getCode: () => 'USDC', isNative: () => false }),
}));

injectMock('config/env', () => ({
  stellar: { network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' },
}));
injectMock('config/stellar', () => ({ server: {}, StellarSdk: {} }));

injectMock('pricing/pricing.service', () => ({
  createQuote: async () => ({ id: 'quote_1', status: 'active' }),
  validateQuoteForExecution: async () => ({ id: 'quote_1', status: 'active' }),
  requote: async () => ({}),
  QUOTE_STATUS: { ACTIVE: 'active', CONSUMED: 'consumed', EXPIRED: 'expired' },
}));
injectMock('pricing/quote.service', () => ({
  isFirmSep38Quote: () => false,
  assertFirmQuoteValidForExecution: () => {},
}));
injectMock('pricing/loyaltyRebate', () => ({ redeemVoucher: async () => null, hasLoyaltyReward: () => false }));

injectMock('compliance/compliance.service', () => ({
  enforceTransactionPolicy: async () => ({
    riskScore: 10,
    profile: { tier: 1 },
    policySnapshot: {
      referenceCurrency: 'NGN',
      sourceAsset: 'USDC',
      sourceAmount: '100.0000000',
      rate: '1550.00',
      convertedAmount: '155000.00',
      source: 'exchangerate-api',
      fetchedAt: '2026-11-25T09:00:00.000Z',
      maxAgeMs: 300000,
      policyVersion: '1',
    },
  }),
}));
injectMock('compliance/riskEngine', () => ({
  evaluateTransactionRisk: async () => ({ score: 5, action: 'allow' }),
  assertRiskAllowsPayment: () => {},
}));
injectMock('compliance/account.service', () => ({ assertAccountActive: () => {} }));
injectMock('compliance/sanctionsScreening', () => ({ screenPaymentParties: async () => ({}) }));
injectMock('compliance/velocityLimits', () => ({
  enforceVelocityLimit: async () => ({ id: 'res_1' }),
  releaseVelocityReservation: async (r) => { calls.releaseReservation.push(r); },
}));

injectMock('common/audit.service', () => ({ writeAuditLog: async () => {} }));
injectMock('common/event.service', () => ({
  appendEvent: async () => {},
  EVENT_TYPES: { PAYMENT_SUBMITTED: 'payment.submitted' },
}));
injectMock('common/records', () => ({ withIdAlias: (x) => x, withIdAliases: (x) => x }));

injectMock('payment/markFailed', () => ({
  markTransactionFailed: async (args) => {
    calls.markFailed.push(args);
    calls.order.push('markFailed');
    currentTx = { ...currentTx, status: 'failed' };
  },
}));
injectMock('payment/payment.transitions', () => ({
  transitionPaymentState: async ({ toState, extraData }) => {
    currentTx = { ...currentTx, status: toState, ...(extraData || {}) };
    return currentTx;
  },
}));
injectMock('payment/refundEngine', () => ({ handleStellarPaymentFailure: async () => {} }));
injectMock('payment/ledger.service', () => ({
  postPaymentSettled: async () => {},
  postPaymentFailed: async () => {},
}));
injectMock('payment/pathPaymentRouter', () => ({ pathAmount: (a) => String(a) }));
injectMock('wallet/assetIdentity', () => ({ resolveConfiguredIssuer: () => 'GISSUER' }));

const txClient = {
  transaction: {
    create: async () => currentTx,
    update: async ({ data }) => { currentTx = { ...currentTx, ...(data || {}) }; return currentTx; },
    updateMany: async () => ({ count: 1 }),
    findUnique: async () => currentTx,
    findFirst: async () => null,
  },
  quote: {
    create: async () => ({ id: 'quote_1' }),
    findUnique: async () => ({ id: 'quote_1', status: 'active' }),
    update: async () => ({ id: 'quote_1' }),
  },
  user: { findFirst: async () => null, findUnique: async () => null },
  wallet: { findUnique: async () => null, findFirst: async () => null },
};

injectMock('common/prisma', () => ({
  $transaction: async (fn) => fn(txClient),
  ...txClient,
}));

// SUT, loaded only once every mock is in place.
const { executePayment } = require('../src/payment/payment.orchestrator');

const reset = () => {
  calls.ensureTrustline.length = 0;
  calls.submitPayment.length = 0;
  calls.markFailed.length = 0;
  calls.releaseReservation.length = 0;
  calls.order.length = 0;
  trustlineError = null;
  trustlineOutcome = { required: true, custodied: true, established: true, submitted: false, alreadyExisted: true };
  currentTx = {
    id: 'tx_1', userId: 1, type: 'send', amount: '100.0000000', asset: 'USDC',
    rail: 'stellar', status: 'processing', metadata: {},
  };
};

const input = (over = {}) => ({
  sender: { id: 1, phoneNumber: '+2348000000001' },
  recipientPhoneNumber: '+2348000000002',
  destination: DEST,
  amount: '100.0000000',
  asset: 'USDC',
  ...over,
});

// ── The hook runs, before submission ────────────────────────────────────────

test('executePayment establishes the recipient trustline before submitting', async () => {
  reset();
  await executePayment(input());

  assert.equal(calls.ensureTrustline.length, 1, 'the trustline hook ran exactly once');
  assert.equal(calls.submitPayment.length, 1, 'the payment was submitted');
  assert.deepEqual(
    calls.order.filter((s) => s === 'trustline' || s === 'submit'),
    ['trustline', 'submit'],
    'the trustline is established BEFORE the payment is submitted',
  );
});

test('the hook is handed the asset being transferred and both recipient identifiers', async () => {
  reset();
  await executePayment(input());

  const args = calls.ensureTrustline[0];
  assert.equal(args.assetCode, 'USDC');
  assert.equal(args.destination, DEST);
  assert.equal(args.recipientPhoneNumber, '+2348000000002');
  assert.equal(args.network, 'testnet');
  assert.equal(args.chain, 'stellar');
  assert.equal(typeof args.resolveSigner, 'function', 'a signer factory is supplied');
});

test('on a path payment the hook receives the DESTINATION asset, not the sent asset', async () => {
  reset();
  await executePayment(input({ asset: 'XLM', destinationAsset: 'USDC', destinationAmount: '50.0000000' }));

  assert.equal(calls.ensureTrustline.length, 1);
  assert.equal(
    calls.ensureTrustline[0].assetCode,
    'USDC',
    'the recipient needs a trustline for what they RECEIVE',
  );
});

test('a native XLM transfer still submits, and the hook reports no trustline needed', async () => {
  reset();
  trustlineOutcome = { required: false, established: true, alreadyExisted: true, submitted: false };
  await executePayment(input({ asset: 'XLM' }));

  assert.equal(calls.ensureTrustline[0].assetCode, 'XLM');
  assert.equal(calls.submitPayment.length, 1, 'native transfers are never blocked');
});

// ── Failure refuses the transfer through the existing accounting path ───────

test('an unestablishable trustline blocks submission and marks the transaction failed', async () => {
  reset();
  trustlineError = Object.assign(
    new Error('Insufficient XLM reserve for a USDC trustline. Keep at least 1.5 XLM, then retry.'),
    { code: 'insufficient_reserve' },
  );

  await assert.rejects(() => executePayment(input()), (error) => {
    assert.equal(error.code, 'insufficient_reserve', 'the original coded error propagates');
    assert.match(error.message, /Keep at least/);
    return true;
  });

  assert.equal(calls.submitPayment.length, 0, 'NOTHING was submitted to the network');
  assert.equal(calls.markFailed.length, 1, 'the transaction was marked failed');
  assert.equal(calls.releaseReservation.length, 1, 'the velocity reservation was released');
  assert.deepEqual(
    calls.order.filter((s) => s !== 'trustline'),
    ['markFailed'],
    'failure flows through the existing accounting path, with no submission',
  );
});

test('a trustline failure happens before submission, so no on-chain attempt is wasted', async () => {
  reset();
  trustlineError = Object.assign(new Error('no signer'), { code: 'no_signer' });
  await assert.rejects(() => executePayment(input())).catch(() => {});
  assert.equal(calls.submitPayment.length, 0);
});

// ── A recipient we do not custody must not block the transfer ───────────────

test('an external recipient does not block the transfer', async () => {
  reset();
  trustlineOutcome = {
    required: true, custodied: false, established: false, submitted: false,
    code: 'recipient_not_custodied',
  };
  await executePayment(input());

  assert.equal(calls.submitPayment.length, 1, 'the transfer proceeds for an external address');
  assert.equal(calls.markFailed.length, 0);
});

test('a newly created trustline still lets the transfer through', async () => {
  reset();
  trustlineOutcome = {
    required: true, custodied: true, established: true, submitted: true,
    alreadyExisted: false, assetId: 'USDC:GISSUER',
  };
  await executePayment(input());

  assert.equal(calls.submitPayment.length, 1);
  assert.deepEqual(calls.order.filter((s) => s === 'trustline' || s === 'submit'), ['trustline', 'submit']);
});
