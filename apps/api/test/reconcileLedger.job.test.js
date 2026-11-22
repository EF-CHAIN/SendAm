const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  runLedgerReconciliation,
  startLedgerReconciliationScheduler,
  DISCREPANCY,
  REPORT_ACTION,
} = require('../src/jobs/reconcileLedger.job');

const NOW = new Date('2026-11-21T01:00:00.000Z');
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const ACCOUNT = 'GACCOUNT1';

const payment = (overrides = {}) => ({
  type: 'payment',
  from: ACCOUNT,
  to: 'GDEST',
  amount: '10.0000000',
  asset_type: 'native',
  transaction_hash: 'h1',
  transaction_successful: true,
  created_at: '2026-11-20T12:00:00Z',
  ...overrides,
});

const horizonWith = ({ records = [], txLookup = async () => ({ successful: true }), fail = false } = {}) => ({
  payments: () => {
    const chain = {
      forAccount: () => chain,
      order: () => chain,
      limit: () => chain,
      includeFailed: () => chain,
      call: async () => {
        if (fail) throw new Error('horizon down');
        return { records, next: async () => ({ records: [] }) };
      },
    };
    return chain;
  },
  transactions: () => ({ transaction: (hash) => ({ call: () => txLookup(hash) }) }),
});

const makePrisma = ({ rows = [], wallets = [{ publicKey: ACCOUNT }], existingCheckpoint = false } = {}) => {
  const checkpoints = [];
  return {
    checkpoints,
    wallet: { findMany: async () => wallets },
    transaction: { findMany: async () => rows },
    reconciliationCheckpoint: {
      findFirst: async () => (existingCheckpoint ? { id: 'cp' } : null),
      create: async ({ data }) => { checkpoints.push(data); return data; },
    },
  };
};

const row = (overrides = {}) => ({
  id: 'tx1', txHash: 'h1', amount: '10.0000000', asset: 'XLM', status: 'success', createdAt: new Date('2026-11-20T12:00:00Z'), ...overrides,
});

const run = async ({ horizon, prisma }) => {
  const audits = [];
  const report = await runLedgerReconciliation({
    prisma, horizonServer: horizon, now: () => NOW, audit: async (entry) => audits.push(entry), log: silentLog,
  });
  return { report, audits };
};

test('clean ledger produces a report with no discrepancies and writes an audit entry', async () => {
  const { report, audits } = await run({ horizon: horizonWith({ records: [payment()] }), prisma: makePrisma({ rows: [row()] }) });
  assert.equal(report.discrepancyCount, 0);
  assert.equal(report.complete, true);
  assert.equal(report.onChainPayments, 1);
  assert.equal(report.reportDate, '2026-11-21');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, REPORT_ACTION);
  assert.equal(audits[0].entityId, '2026-11-21');
});

test('on-chain payment with no database record is reported as missing_in_db', async () => {
  const { report } = await run({ horizon: horizonWith({ records: [payment()] }), prisma: makePrisma({ rows: [] }) });
  assert.deepEqual(report.counts, { [DISCREPANCY.MISSING_IN_DB]: 1 });
  assert.equal(report.discrepancies[0].txHash, 'h1');
});

test('failed on-chain payments without a database record are not flagged', async () => {
  const { report } = await run({
    horizon: horizonWith({ records: [payment({ transaction_successful: false })] }),
    prisma: makePrisma({ rows: [] }),
  });
  assert.equal(report.discrepancyCount, 0);
});

test('database success that is absent from the ledger is missing_on_chain', async () => {
  const notFound = async () => { const e = new Error('nf'); e.response = { status: 404 }; throw e; };
  const { report } = await run({
    horizon: horizonWith({ records: [], txLookup: notFound }),
    prisma: makePrisma({ rows: [row()] }),
  });
  assert.deepEqual(report.counts, { [DISCREPANCY.MISSING_ON_CHAIN]: 1 });
});

test('a database success found by direct lookup is not reported missing', async () => {
  const { report } = await run({
    horizon: horizonWith({ records: [], txLookup: async () => ({ successful: true }) }),
    prisma: makePrisma({ rows: [row()] }),
  });
  assert.equal(report.discrepancyCount, 0);
});

test('non-404 lookup errors make the report incomplete instead of claiming a mismatch', async () => {
  const { report } = await run({
    horizon: horizonWith({ records: [], txLookup: async () => { throw new Error('timeout'); } }),
    prisma: makePrisma({ rows: [row()] }),
  });
  assert.equal(report.complete, false);
  assert.equal(report.discrepancyCount, 0);
});

test('pending database row already closed on-chain is reported', async () => {
  const { report } = await run({
    horizon: horizonWith({ records: [payment()] }),
    prisma: makePrisma({ rows: [row({ status: 'pending' })] }),
  });
  assert.deepEqual(report.counts, { [DISCREPANCY.PENDING_BUT_ON_CHAIN]: 1 });
});

test('amount mismatch is detected in exact stroops, formatting differences are not', async () => {
  const mismatch = await run({
    horizon: horizonWith({ records: [payment({ amount: '10.0000001' })] }),
    prisma: makePrisma({ rows: [row()] }),
  });
  assert.deepEqual(mismatch.report.counts, { [DISCREPANCY.AMOUNT_MISMATCH]: 1 });

  const formatting = await run({
    horizon: horizonWith({ records: [payment({ amount: '10.0000000' })] }),
    prisma: makePrisma({ rows: [row({ amount: '10' })] }),
  });
  assert.equal(formatting.report.discrepancyCount, 0);
});

test('database success vs on-chain failure is a status mismatch', async () => {
  const { report } = await run({
    horizon: horizonWith({ records: [payment({ transaction_successful: false })] }),
    prisma: makePrisma({ rows: [row()] }),
  });
  assert.deepEqual(report.counts, { [DISCREPANCY.STATUS_MISMATCH]: 1 });
});

test('stale hashless pending rows are flagged but fresh ones are not', async () => {
  const stale = row({ id: 'old', txHash: null, status: 'pending', createdAt: new Date('2026-11-20T23:00:00Z') });
  const fresh = row({ id: 'new', txHash: null, status: 'pending', createdAt: new Date('2026-11-21T00:45:00Z') });
  const { report } = await run({ horizon: horizonWith(), prisma: makePrisma({ rows: [stale, fresh] }) });
  assert.deepEqual(report.counts, { [DISCREPANCY.STALE_PENDING]: 1 });
  assert.equal(report.discrepancies[0].transactionId, 'old');
});

test('an unreachable account marks the report incomplete and still writes it', async () => {
  const { report, audits } = await run({ horizon: horizonWith({ fail: true }), prisma: makePrisma() });
  assert.equal(report.complete, false);
  assert.equal(report.scanErrors[0].publicKey, ACCOUNT);
  assert.equal(audits.length, 1);
});

test('payments before the 24h window are ignored', async () => {
  const old = payment({ created_at: '2026-11-19T00:00:00Z' });
  const { report } = await run({ horizon: horizonWith({ records: [old] }), prisma: makePrisma() });
  assert.equal(report.onChainPayments, 0);
});

test('checkpoints are created once per database-linked discrepancy', async () => {
  const prisma = makePrisma({ rows: [row({ status: 'pending' })] });
  const { report } = await run({ horizon: horizonWith({ records: [payment()] }), prisma });
  assert.equal(report.checkpointsCreated, 1);
  assert.equal(prisma.checkpoints[0].checkpointType, 'ledger_horizon');

  const dup = makePrisma({ rows: [row({ status: 'pending' })], existingCheckpoint: true });
  const second = await run({ horizon: horizonWith({ records: [payment()] }), prisma: dup });
  assert.equal(second.report.checkpointsCreated, 0);
});

test('scheduler runs once per day and skips when a report already exists', async () => {
  let clock = new Date('2026-11-21T00:05:00Z');
  let existing = null;
  const prisma = { auditLog: { findFirst: async () => existing } };
  const runs = [];
  const scheduler = startLedgerReconciliationScheduler({
    prisma, runHourUtc: 0, tickMs: 3600000, now: () => clock, log: silentLog, run: async () => { runs.push(1); existing = { id: 'a' }; return {}; },
  });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(runs.length, 1);
  scheduler.stop();
});

test('scheduler waits for the configured hour and survives job failures', async () => {
  const prisma = { auditLog: { findFirst: async () => null } };
  let attempts = 0;
  const early = startLedgerReconciliationScheduler({
    prisma, runHourUtc: 3, now: () => new Date('2026-11-21T01:00:00Z'), log: silentLog, run: async () => { attempts += 1; },
  });
  await early.tick();
  assert.equal(attempts, 0);
  early.stop();

  const failing = startLedgerReconciliationScheduler({
    prisma, runHourUtc: 0, now: () => NOW, log: silentLog, run: async () => { throw new Error('boom'); },
  });
  assert.equal(await failing.tick(), null);
  failing.stop();
});
