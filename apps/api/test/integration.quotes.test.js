// ---------------------------------------------------------------------------
// PostgreSQL integration tests for the atomic quote/payment work.
//
// These exercise the REAL Prisma client, schema, and pricing/compliance code
// paths (the parts a mock-based unit test cannot prove): transactional
// rollback, expired-quote rejection, idempotent retries under concurrency, and
// requote/reconciliation. They require a PostgreSQL connection string in
// SENDAM_TEST_DATABASE_URL; without it the whole suite is skipped so the
// default `node --test` run stays offline and fast.
// ---------------------------------------------------------------------------
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execSync } = require('node:child_process');

const testDbUrl = process.env.SENDAM_TEST_DATABASE_URL;
const apiRoot = path.resolve(__dirname, '..');

if (!testDbUrl) {
  test('quote/payment PostgreSQL integration: SKIPPED (set SENDAM_TEST_DATABASE_URL to run against PostgreSQL)', () => {});
} else {
  // Point the app's Prisma client at the test database before anything loads.
  process.env.DATABASE_URL = testDbUrl;

  // Sync the generated client + schema to the test database.
  execSync('npx prisma generate', { cwd: apiRoot, stdio: 'ignore' });
  execSync('npx prisma db push --force-reset --skip-generate --accept-data-loss', {
    cwd: apiRoot,
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: testDbUrl },
  });

  // Mock the two external boundaries (Stellar submit + compliance policy) so
  // the orchestrator can run end-to-end without network/RPC access.
  const DEST = 'GCXQJ7E6C6TQX7GVV3T6HX3Q7H3P6G6X7Q7J7E6C6TQX7GVV3T6HX3Q7';
  const walletMock = {
    createOrGetWallet: async () => ({ id: 'w_test', publicKey: DEST, encryptedSecretKey: 'enc' }),
    submitPayment: async () => ({ txHash: 'test_hash', explorerUrl: 'https://stellar.expert/test_hash' }),
  };
  const complianceMock = { enforceTransactionPolicy: async () => ({ riskScore: 5 }) };

  require.cache[path.resolve(apiRoot, 'src/wallet/wallet.service.js')] = {
    id: path.resolve(apiRoot, 'src/wallet/wallet.service.js'),
    filename: path.resolve(apiRoot, 'src/wallet/wallet.service.js'),
    loaded: true,
    exports: walletMock,
  };
  require.cache[path.resolve(apiRoot, 'src/compliance/compliance.service.js')] = {
    id: path.resolve(apiRoot, 'src/compliance/compliance.service.js'),
    filename: path.resolve(apiRoot, 'src/compliance/compliance.service.js'),
    loaded: true,
    exports: complianceMock,
  };

  const prisma = require('../src/common/prisma');
  const { executePayment } = require('../src/payment/payment.orchestrator');
  const { createQuote, validateQuoteForExecution, requote, reconcileQuotes, QUOTE_STATUS } = require('../src/pricing/pricing.service');

  let user;

  let userSeq = 0;
  const makeUser = async () => prisma.user.create({
    data: { phoneNumber: `+${Date.now()}${process.pid}${userSeq++}` },
  });

  before(async () => {
    user = await makeUser();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  // --- Rollback: a quote written through the tx client is removed on rollback --
  test('rollback: a quote created inside a transaction is gone after the transaction throws', async () => {
    // Use an isolated user so concurrent tests can't skew the row count.
    const rollbackUser = await makeUser();
    await assert.rejects(() => prisma.$transaction(async (tx) => {
      await createQuote({
        userId: rollbackUser.id,
        sourceCurrency: 'XLM',
        targetCurrency: 'XLM',
        sourceAmount: '5.0000000',
        route: 'stellar',
        provider: 'stellar',
        tx,
      });
      throw new Error('forced rollback');
    }));

    const count = await prisma.quote.count({ where: { userId: rollbackUser.id } });
    assert.equal(count, 0, 'orphan quote must not survive a rollback');
  });

  // --- Happy path: quote + reservation commit together, quote is consumed -----
  test('executePayment: commits a quote (consumed) and a successful transaction together', async () => {
    const result = await executePayment({ sender: user, destination: DEST, amount: '4.0000000', asset: 'XLM' });

    assert.equal(result.transaction.status, 'success');
    const quote = await prisma.quote.findUnique({ where: { id: result.quote.id } });
    assert.ok(quote);
    assert.equal(quote.status, QUOTE_STATUS.CONSUMED);
    const tx = await prisma.transaction.findUnique({ where: { id: result.transaction.id } });
    assert.equal(tx.quoteId, quote.id);
  });

  // --- Expired quotes cannot be submitted -------------------------------------
  test('executePayment: an expired quote is rejected and reserves no transaction', async () => {
    // Isolated sender so concurrent activity can't skew the assertions.
    const senderUser = await makeUser();
    const expired = await prisma.quote.create({
      data: {
        userId: senderUser.id,
        sourceCurrency: 'XLM',
        targetCurrency: 'XLM',
        sourceAmount: '1.0000000',
        status: QUOTE_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const txBefore = await prisma.transaction.count({ where: { userId: senderUser.id } });
    await assert.rejects(
      () => executePayment({ sender: senderUser, destination: DEST, amount: '1.0000000', asset: 'XLM', quoteId: expired.id }),
      { code: 'QUOTE_EXPIRED' },
    );

    assert.equal(await prisma.transaction.count({ where: { userId: senderUser.id } }), txBefore, 'no transaction reserved for an expired quote');
    const after = await prisma.quote.findUnique({ where: { id: expired.id } });
    assert.notEqual(after.status, QUOTE_STATUS.CONSUMED, 'expired quote is not consumed by a rejected submit');
  });

  // --- Mismatched quotes cannot be submitted ----------------------------------
  test('validateQuoteForExecution: rejects wrong owner, amount, and asset pair', async () => {
    const other = await makeUser();
    const q = await prisma.quote.create({
      data: { userId: user.id, sourceCurrency: 'XLM', targetCurrency: 'XLM', sourceAmount: '10.0000000', status: QUOTE_STATUS.ACTIVE, expiresAt: new Date(Date.now() + 60000) },
    });

    await assert.rejects(
      () => validateQuoteForExecution({ quote: { ...q, userId: other.id }, userId: user.id, asset: 'XLM', amount: '10.0000000' }),
      { code: 'QUOTE_OWNERSHIP' },
    );
    await assert.rejects(
      () => validateQuoteForExecution({ quote: q, userId: user.id, asset: 'XLM', amount: '11.0000000' }),
      { code: 'QUOTE_AMOUNT' },
    );
    await assert.rejects(
      () => validateQuoteForExecution({ quote: { ...q, sourceCurrency: 'USDC', targetCurrency: 'USDC' }, userId: user.id, asset: 'XLM', amount: '10.0000000' }),
      { code: 'QUOTE_ASSET_PAIR' },
    );
  });

  // --- Idempotent retries: no duplicate active quotes or transactions ---------
  test('concurrent createQuote with the same idempotencyKey yields exactly one active quote', async () => {
    const key = `q_${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 12 }, () => createQuote({
      userId: user.id,
      sourceCurrency: 'XLM',
      targetCurrency: 'XLM',
      sourceAmount: '1.0000000',
      route: 'stellar',
      provider: 'stellar',
      idempotencyKey: key,
      tx: prisma,
    })));
    const ids = new Set(results.map((r) => r.id));
    assert.equal(ids.size, 1);
  });

  test('concurrent executePayment with the same idempotencyKey yields exactly one transaction', async () => {
    const key = `t_${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => executePayment({
      sender: user,
      destination: DEST,
      amount: '2.0000000',
      asset: 'XLM',
      idempotencyKey: key,
    })));
    const txIds = new Set(results.map((r) => r.transaction.id));
    assert.equal(txIds.size, 1, 'retries must not create duplicate transactions');
    assert.equal(await prisma.transaction.count({ where: { idempotencyKey: key } }), 1);
  });

  // --- Safe requote ------------------------------------------------------------
  test('requote: supersedes an expired quote and leaves the old one replaced', async () => {
    const stale = await prisma.quote.create({
      data: { userId: user.id, sourceCurrency: 'XLM', targetCurrency: 'XLM', sourceAmount: '1.0000000', status: QUOTE_STATUS.EXPIRED, expiresAt: new Date(Date.now() - 1000) },
    });
    const fresh = await requote({ userId: user.id, quoteId: stale.id });
    assert.notEqual(fresh.id, stale.id);
    assert.equal(fresh.status, QUOTE_STATUS.ACTIVE);

    const old = await prisma.quote.findUnique({ where: { id: stale.id } });
    assert.equal(old.status, QUOTE_STATUS.REPLACED);
    assert.equal(old.replacedById, fresh.id);
  });

  // --- Reconciliation of orphan / expired quotes ------------------------------
  test('reconcileQuotes: closes expired and orphaned active quotes', async () => {
    const expired = await prisma.quote.create({
      data: { userId: user.id, sourceCurrency: 'XLM', targetCurrency: 'XLM', sourceAmount: '1.0000000', status: QUOTE_STATUS.ACTIVE, expiresAt: new Date(Date.now() - 5000) },
    });
    const orphan = await prisma.quote.create({
      data: { userId: user.id, sourceCurrency: 'XLM', targetCurrency: 'XLM', sourceAmount: '1.0000000', status: QUOTE_STATUS.ACTIVE, expiresAt: new Date(Date.now() + 60000), createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const result = await reconcileQuotes({ prismaClient: prisma, now: new Date(), orphanGraceMs: 60 * 60 * 1000 });
    assert.ok(result.expired >= 1);
    assert.ok(result.orphaned >= 1);

    assert.equal((await prisma.quote.findUnique({ where: { id: expired.id } })).status, QUOTE_STATUS.EXPIRED);
    assert.equal((await prisma.quote.findUnique({ where: { id: orphan.id } })).status, QUOTE_STATUS.ORPHANED);
  });
}
