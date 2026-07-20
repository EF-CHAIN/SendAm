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
  createOrGetWallet:        mock.fn(),
  submitPayment:            mock.fn(),
  writeAuditLog:            mock.fn(),
  markTransactionFailed:    mock.fn(),
  withIdAlias:              mock.fn((x) => x),
  prismaTxCreate:           mock.fn(),
  prismaTxUpdate:           mock.fn(),
};

const resetMockCalls = () => { for (const fn of Object.values(mocks)) fn.mock.resetCalls(); };

injectMock('wallet/stellar.adapter',     () => ({ validateAddress: mocks.validateAddress }));
injectMock('compliance/compliance.service', () => ({ enforceTransactionPolicy: mocks.enforceTransactionPolicy }));
injectMock('pricing/pricing.service',    () => ({ createQuote: mocks.createQuote }));
injectMock('wallet/wallet.service',      () => ({ createOrGetWallet: mocks.createOrGetWallet, submitPayment: mocks.submitPayment }));
injectMock('common/audit.service',       () => ({ writeAuditLog: mocks.writeAuditLog }));
injectMock('payment/markFailed',         () => ({ markTransactionFailed: mocks.markTransactionFailed }));
injectMock('common/records',             () => ({ withIdAlias: mocks.withIdAlias }));
injectMock('common/prisma',              () => ({ transaction: { create: mocks.prismaTxCreate, update: mocks.prismaTxUpdate } }));

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
  amount: '100',
  asset: 'USDC',
};

const txRow   = { id: 'tx_1', userId: 1, type: 'send', amount: '100', asset: 'USDC', rail: 'stellar', status: 'processing', metadata: { fee: '1.00', riskScore: 10 } };
const wallet  = { id: 'wallet_1', publicKey: dest, encryptedSecretKey: 'encrypted' };
const submitOk = { txHash: 'abc123', explorerUrl: 'https://stellar.expert/abc123' };
const successTx = { ...txRow, status: 'success', txHash: 'abc123', explorerUrl: 'https://stellar.expert/abc123' };
const quote   = { id: 'quote_1' };

const setUpHappyPath = () => {
  mocks.validateAddress.mock.mockImplementation(() => true);
  mocks.enforceTransactionPolicy.mock.mockImplementation(() => ({ riskScore: 10 }));
  mocks.createQuote.mock.mockImplementation(() => quote);
  mocks.prismaTxCreate.mock.mockImplementation(() => txRow);
  mocks.createOrGetWallet.mock.mockImplementation(() => wallet);
  mocks.submitPayment.mock.mockImplementation(() => submitOk);
  mocks.prismaTxUpdate.mock.mockImplementation(() => successTx);
  mocks.writeAuditLog.mock.mockImplementation(() => {});
};

// ---------------------------------------------------------------------------
// Pure-export unit tests
// ---------------------------------------------------------------------------
test('calculateFee: returns 1% of the amount', () => {
  assert.equal(calculateFee('100'), '1.00');
  assert.equal(calculateFee('250'), '2.50');
  assert.equal(calculateFee('0'), '0.00');
});

test('calculateFee: handles non-numeric input gracefully', () => {
  assert.equal(calculateFee('abc'), '0');
  assert.equal(calculateFee(undefined), '0');
});

test('buildReceipt: shapes a receipt from a successful transaction', () => {
  const tx = { id: 'tx_1', status: 'success', amount: '100', asset: 'USDC', rail: 'stellar', explorerUrl: 'https://stellar.expert/abc123' };
  assert.deepEqual(buildReceipt({ transaction: tx }), {
    transactionId: 'tx_1',
    status: 'success',
    amount: '100',
    asset: 'USDC',
    rail: 'stellar',
    receiptUrl: 'https://stellar.expert/abc123',
  });
});

// ---------------------------------------------------------------------------
// executePayment – happy path
// ---------------------------------------------------------------------------
test('executePayment: happy path returns transaction, quote, and receipt', async () => {
  resetMockCalls();
  setUpHappyPath();

  const result = await executePayment(baseInput);

  assert.ok(result.transaction);
  assert.equal(result.transaction.status, 'success');
  assert.equal(result.quote.id, 'quote_1');
  assert.ok(result.receipt);
  assert.equal(result.receipt.transactionId, 'tx_1');
  assert.equal(result.receipt.status, 'success');
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
});

// ---------------------------------------------------------------------------
// FAILURE PATH 2: adapter submit failure → transaction marked failed,
//                  original error reaches the caller
// ---------------------------------------------------------------------------
test('executePayment: adapter submit failure marks transaction failed and throws the ORIGINAL error', async () => {
  resetMockCalls();
  setUpHappyPath();
  // Override submitPayment to fail
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
