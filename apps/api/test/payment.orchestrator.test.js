const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers: inject a mock module into require.cache so the SUT gets it
// ---------------------------------------------------------------------------
const injectMock = (relativeFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    exports: factory(),
  };
};

// ---------------------------------------------------------------------------
// Shared mutable mocks – reset between tests via resetMockCalls()
// ---------------------------------------------------------------------------
const mocks = {
  validateAddress:          mock.fn(),
  enforceTransactionPolicy: mock.fn(),
  createQuote:              mock.fn(),
  validateQuoteForExecution: mock.fn(),
  requote:                  mock.fn(),
  createOrGetWallet:        mock.fn(),
  submitPayment:            mock.fn(),
  writeAuditLog:            mock.fn(),
  markTransactionFailed:    mock.fn(),
  withIdAlias:              mock.fn((x) => x),
  prismaTxCreate:           mock.fn(),
  prismaTxUpdate:           mock.fn(),
  prismaTxFindUnique:       mock.fn(),
  prismaQuoteCreate:        mock.fn(),
  prismaQuoteFindUnique:    mock.fn(),
  prismaQuoteUpdate:        mock.fn(),
  QUOTE_STATUS:             { ACTIVE: 'active', CONSUMED: 'consumed', EXPIRED: 'expired', REPLACED: 'replaced', ORPHANED: 'orphaned' },
};

const resetMockCalls = () => { for (const fn of Object.values(mocks)) fn.mock?.resetCalls?.(); };

// The transaction client handed to prisma.$transaction — used to prove that
// quote persistence now flows through the active transaction, not the global
// client (the root-cause of orphan quotes on rollback).
const txMock = {
  transaction: {
    create: mocks.prismaTxCreate,
    update: mocks.prismaTxUpdate,
    findUnique: mocks.prismaTxFindUnique,
  },
  quote: {
    create: mocks.prismaQuoteCreate,
    findUnique: mocks.prismaQuoteFindUnique,
    update: mocks.prismaQuoteUpdate,
  },
};

injectMock('wallet/stellar.adapter',        () => ({ validateAddress: mocks.validateAddress }));
injectMock('compliance/compliance.service', () => ({ enforceTransactionPolicy: mocks.enforceTransactionPolicy }));
injectMock('pricing/pricing.service',       () => ({
  createQuote: mocks.createQuote,
  validateQuoteForExecution: mocks.validateQuoteForExecution,
  requote: mocks.requote,
  QUOTE_STATUS: mocks.QUOTE_STATUS,
}));
injectMock('wallet/wallet.service',          () => ({ createOrGetWallet: mocks.createOrGetWallet, submitPayment: mocks.submitPayment }));
injectMock('common/audit.service',           () => ({ writeAuditLog: mocks.writeAuditLog }));
injectMock('payment/markFailed',             () => ({ markTransactionFailed: mocks.markTransactionFailed }));
injectMock('common/records',                 () => ({ withIdAlias: mocks.withIdAlias }));
injectMock('common/prisma',                  () => ({
  $transaction: async (fn) => fn(txMock),
  transaction: txMock.transaction,
  quote: txMock.quote,
}));

// ---------------------------------------------------------------------------
// SUT – loaded after all mocks are in place
// ---------------------------------------------------------------------------
const { executePayment, calculateFee, buildReceipt } = require('../src/payment/payment.orchestrator');

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const sender  = { id: 1, phoneNumber: '+2348000000001' };
const dest    = 'GCXQJ7E6C6TQX7GVV3T6HX3Q7H3P6G6X7Q7J7E6C6TQX7GVV3T6HX3Q7';
const baseInput = {
  sender,
  recipientPhoneNumber: '+2348000000002',
  destination: dest,
  amount: '100.0000000',
  asset: 'USDC',
};

const txRow   = { id: 'tx_1', userId: 1, type: 'send', amount: '100.0000000', asset: 'USDC', rail: 'stellar', status: 'processing', metadata: { fee: '1.00', riskScore: 10 } };
const wallet  = { id: 'wallet_1', publicKey: dest, encryptedSecretKey: 'encrypted' };
const submitOk = { txHash: 'abc123', explorerUrl: 'https://stellar.expert/abc123' };
const pendingTx = { ...txRow, status: 'pending', txHash: 'abc123', explorerUrl: 'https://stellar.expert/abc123' };
const successTx = { ...txRow, status: 'success', txHash: 'abc123', explorerUrl: 'https://stellar.expert/abc123' };
const quote   = { id: 'quote_1', status: 'active' };

const setUpHappyPath = () => {
  mocks.validateAddress.mock.mockImplementation(() => true);
  mocks.enforceTransactionPolicy.mock.mockImplementation(() => ({ riskScore: 10 }));
  mocks.createQuote.mock.mockImplementation(() => quote);
  mocks.prismaTxCreate.mock.mockImplementation(() => txRow);
  mocks.createOrGetWallet.mock.mockImplementation(() => wallet);
  mocks.submitPayment.mock.mockImplementation(() => submitOk);
  mocks.prismaTxUpdate.mock.mockImplementation(() => pendingTx);
  mocks.writeAuditLog.mock.mockImplementation(() => {});
  mocks.validateQuoteForExecution.mock.mockImplementation(() => quote);
};

const quoteError = (code, message) => {
  const e = new Error(message || code);
  e.code = code;
  return e;
};

// ---------------------------------------------------------------------------
// Pure-export unit tests
// ---------------------------------------------------------------------------
test('calculateFee: returns 1% of the amount', () => {
  assert.equal(calculateFee('100', 'USDC'), '1.0000000');
  assert.equal(calculateFee('250', 'NGN'), '2.50');
  assert.equal(calculateFee('0.0000001', 'XLM'), '0.0000000');
});

test('calculateFee: rejects invalid precision before side effects', () => {
  assert.throws(() => calculateFee('abc', 'USDC'), /positive decimal/);
  assert.throws(() => calculateFee('1.00000001', 'USDC'), /at most 7 decimal/);
});

test('buildReceipt: shapes a receipt from a successful transaction', () => {
  const tx = { id: 'tx_1', status: 'success', amount: '100.0000000', asset: 'USDC', rail: 'stellar', explorerUrl: 'https://stellar.expert/abc123' };
  assert.deepEqual(buildReceipt({ transaction: tx }), {
    transactionId: 'tx_1',
    receiptId: 'SDA-tx_1',
    status: 'success',
    amount: '100.0000000',
    asset: 'USDC',
    rail: 'stellar',
    receiptUrl: 'https://stellar.expert/abc123',
  });
});

// ---------------------------------------------------------------------------
// executePayment – happy path (finality-aware)
// ---------------------------------------------------------------------------
test('executePayment: happy path returns transaction in pending state with receipt: null', async () => {
  resetMockCalls();
  setUpHappyPath();

  const result = await executePayment(baseInput);

  assert.ok(result.transaction);
  // Must NOT be 'success' — finality is deferred to the reconciler.
  assert.equal(result.transaction.status, 'pending');
  assert.equal(result.quote.id, 'quote_1');
  // No receipt until ledger-backed finality is confirmed.
  assert.equal(result.receipt, null);
});

test('executePayment: transaction is written as pending (not success) after submitPayment returns', async () => {
  resetMockCalls();
  setUpHappyPath();

  await executePayment(baseInput);

  assert.equal(mocks.prismaTxUpdate.mock.callCount(), 1);
  const updateData = mocks.prismaTxUpdate.mock.calls[0].arguments[0].data;
  assert.equal(updateData.status, 'pending',
    'status must be pending after submission — success requires ledger confirmation');
  assert.equal(updateData.txHash, 'abc123');
});

test('executePayment: audit log records payment.submitted (not payment.executed) on the pending path', async () => {
  resetMockCalls();
  setUpHappyPath();

  await executePayment(baseInput);

  assert.equal(mocks.writeAuditLog.mock.callCount(), 1);
  const logCall = mocks.writeAuditLog.mock.calls[0].arguments[0];
  assert.equal(logCall.action, 'payment.submitted');
  assert.equal(logCall.metadata.status, 'pending');
});

test('executePayment: quote is persisted through the active transaction client (no orphan on rollback)', async () => {
  resetMockCalls();
  setUpHappyPath();

  await executePayment(baseInput);

  // createQuote must receive the transactional client, not the global prisma.
  assert.equal(mocks.createQuote.mock.callCount(), 1);
  const passedTx = mocks.createQuote.mock.calls[0].arguments[0].tx;
  assert.equal(passedTx, txMock);
});

// ---------------------------------------------------------------------------
// FAILURE PATH 1: compliance rejection → no transaction row is written
// ---------------------------------------------------------------------------
test('executePayment: compliance rejection does NOT write a transaction row and throws the compliance error', async () => {
  resetMockCalls();
  mocks.validateAddress.mock.mockImplementation(() => true);
  mocks.enforceTransactionPolicy.mock.mockImplementation(async () => {
    throw new Error('This payment exceeds your tier 1 daily limit.');
  });

  await assert.rejects(
    () => executePayment(baseInput),
    { message: 'This payment exceeds your tier 1 daily limit.' },
  );

  assert.equal(mocks.prismaTxCreate.mock.callCount(), 0);
  assert.equal(mocks.createQuote.mock.callCount(), 0);
});

// ---------------------------------------------------------------------------
// FAILURE PATH 2: adapter submit failure → transaction marked failed,
//                  original error reaches the caller
// ---------------------------------------------------------------------------
test('executePayment: adapter submit failure marks transaction failed and throws the ORIGINAL error', async () => {
  resetMockCalls();
  setUpHappyPath();
  mocks.submitPayment.mock.mockImplementation(async () => {
    throw new Error('tx_bad_seq');
  });
  mocks.markTransactionFailed.mock.mockImplementation(() => {});

  await assert.rejects(
    () => executePayment(baseInput),
    { message: 'tx_bad_seq' },
  );

  assert.equal(mocks.markTransactionFailed.mock.callCount(), 1);
  const call = mocks.markTransactionFailed.mock.calls[0];
  assert.equal(call.arguments[0].transactionId, 'tx_1');
  assert.equal(call.arguments[0].error.message, 'tx_bad_seq');
});

// ---------------------------------------------------------------------------
// Quote validation at execution: expired / mismatched quotes cannot be submitted
// ---------------------------------------------------------------------------
const withQuote = (overrides = {}) => ({ id: 'quote_x', status: 'active', expiresAt: new Date(Date.now() + 60000), ...overrides });

test('executePayment: rejects an expired quote and never creates a transaction', async () => {
  resetMockCalls();
  setUpHappyPath();
  mocks.prismaQuoteFindUnique.mock.mockImplementation(() => withQuote({ expiresAt: new Date(Date.now() - 1000) }));
  mocks.validateQuoteForExecution.mock.mockImplementation(() => { throw quoteError('QUOTE_EXPIRED', 'Quote has expired.'); });

  await assert.rejects(() => executePayment({ ...baseInput, quoteId: 'quote_x' }), { code: 'QUOTE_EXPIRED' });

  assert.equal(mocks.prismaTxCreate.mock.callCount(), 0);
  assert.equal(mocks.prismaQuoteUpdate.mock.callCount(), 0);
});

test('executePayment: rejects a quote with a mismatched amount', async () => {
  resetMockCalls();
  setUpHappyPath();
  mocks.prismaQuoteFindUnique.mock.mockImplementation(() => withQuote());
  mocks.validateQuoteForExecution.mock.mockImplementation(() => { throw quoteError('QUOTE_AMOUNT', 'Quote amount does not match the payment.'); });

  await assert.rejects(() => executePayment({ ...baseInput, quoteId: 'quote_x' }), { code: 'QUOTE_AMOUNT' });
  assert.equal(mocks.prismaTxCreate.mock.callCount(), 0);
});

test('executePayment: rejects a quote owned by another user', async () => {
  resetMockCalls();
  setUpHappyPath();
  mocks.prismaQuoteFindUnique.mock.mockImplementation(() => withQuote({ userId: 999 }));
  mocks.validateQuoteForExecution.mock.mockImplementation(() => { throw quoteError('QUOTE_OWNERSHIP', 'Quote does not belong to this user.'); });

  await assert.rejects(() => executePayment({ ...baseInput, quoteId: 'quote_x' }), { code: 'QUOTE_OWNERSHIP' });
  assert.equal(mocks.prismaTxCreate.mock.callCount(), 0);
});

test('executePayment: rejects a quote whose asset pair does not match', async () => {
  resetMockCalls();
  setUpHappyPath();
  mocks.prismaQuoteFindUnique.mock.mockImplementation(() => withQuote());
  mocks.validateQuoteForExecution.mock.mockImplementation(() => { throw quoteError('QUOTE_ASSET_PAIR', 'Quote asset pair does not match the payment.'); });

  await assert.rejects(() => executePayment({ ...baseInput, quoteId: 'quote_x' }), { code: 'QUOTE_ASSET_PAIR' });
  assert.equal(mocks.prismaTxCreate.mock.callCount(), 0);
});

test('executePayment: a valid quote is consumed atomically with the transaction', async () => {
  resetMockCalls();
  setUpHappyPath();
  const activeQuote = withQuote();
  mocks.prismaQuoteFindUnique.mock.mockImplementation(() => activeQuote);
  mocks.validateQuoteForExecution.mock.mockImplementation(() => activeQuote);
  mocks.prismaQuoteUpdate.mock.mockImplementation(() => ({ ...activeQuote, status: 'consumed' }));

  await executePayment({ ...baseInput, quoteId: 'quote_x' });

  assert.equal(mocks.prismaQuoteUpdate.mock.callCount(), 1);
  const updateCall = mocks.prismaQuoteUpdate.mock.calls[0];
  assert.equal(updateCall.arguments[0].where.id, 'quote_x');
  assert.equal(updateCall.arguments[0].data.status, 'consumed');
  assert.equal(mocks.prismaTxCreate.mock.callCount(), 1);
  assert.equal(mocks.prismaTxCreate.mock.calls[0].arguments[0].data.quoteId, 'quote_x');
});

// ---------------------------------------------------------------------------
// Idempotency: retrying a request must not create duplicate quotes/transactions
// ---------------------------------------------------------------------------
test('executePayment: same idempotencyKey returns the existing successful transaction with receipt, without re-submitting', async () => {
  resetMockCalls();
  setUpHappyPath();
  const prior = { ...successTx, idempotencyKey: 'req_42' };
  mocks.prismaTxFindUnique.mock.mockImplementation(() => prior);
  mocks.prismaQuoteFindUnique.mock.mockImplementation(() => withQuote());

  const result = await executePayment({ ...baseInput, idempotencyKey: 'req_42' });

  assert.equal(mocks.prismaTxCreate.mock.callCount(), 0, 'no duplicate transaction created');
  assert.equal(mocks.createQuote.mock.callCount(), 0, 'no duplicate quote created');
  assert.equal(mocks.submitPayment.mock.callCount(), 0, 'must not re-submit a settled payment');
  assert.equal(result.transaction.id, 'tx_1');
  // A previously confirmed success should return a receipt (idempotent re-delivery).
  assert.ok(result.receipt, 'receipt must be present for an already-settled transaction');
  assert.equal(result.receipt.status, 'success');
});

test('executePayment: same idempotencyKey for a pending transaction returns receipt: null without re-submitting', async () => {
  resetMockCalls();
  setUpHappyPath();
  const prior = { ...pendingTx, idempotencyKey: 'req_43' };
  mocks.prismaTxFindUnique.mock.mockImplementation(() => prior);
  mocks.prismaQuoteFindUnique.mock.mockImplementation(() => withQuote());

  const result = await executePayment({ ...baseInput, idempotencyKey: 'req_43' });

  assert.equal(mocks.submitPayment.mock.callCount(), 0, 'must not re-submit a pending payment');
  assert.equal(result.transaction.status, 'pending');
  assert.equal(result.receipt, null, 'no receipt until ledger-backed finality');
});
