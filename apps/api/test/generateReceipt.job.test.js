const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderReceiptPdf, processReceiptJob, enqueueReceiptGeneration } = require('../src/jobs/generateReceipt.job');

const tx = {
  id: 'tx1',
  userId: 'u1',
  amount: '10',
  asset: 'XLM',
  status: 'success',
  txHash: 'abcdef1234567890',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  destination: 'GDEST1234567890ABCDEFGH',
  user: { phoneNumber: '2348012345678' },
};

const setup = (overrides = {}) => {
  const log = { uploads: [], presigns: [], sends: [] };
  return {
    log,
    deps: {
      db: { transaction: { findUnique: async () => tx } },
      bucket: 'b',
      upload: async (a) => { log.uploads.push(a); },
      presign: async (a) => { log.presigns.push(a); return 'https://s3.example/signed'; },
      sendMessage: async (...a) => { log.sends.push(a); },
      ...overrides,
    },
  };
};

test('renders a valid PDF well under one second', async () => {
  const started = Date.now();
  const pdf = await renderReceiptPdf({
    receiptId: 'SDA-tx1',
    status: 'success',
    amount: '10',
    asset: 'XLM',
    fee: '0.1',
    sender: '2348****5678',
    recipient: 'GDES****EFGH',
    timestamp: '2026-01-01T00:00:00.000Z',
    transactionHash: 'abc',
    receiptUrl: 'https://x/receipt/SDA-tx1',
    metadata: {},
  });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(Date.now() - started < 1000);
});

test('uploads the PDF, presigns for 24h and WhatsApps the link to the owner', async () => {
  const { deps, log } = setup();
  const out = await processReceiptJob({ data: { transactionId: 'tx1', phoneNumber: '2340000000000' } }, deps);
  assert.equal(log.uploads[0].key, 'receipts/SDA-tx1.pdf');
  assert.equal(log.uploads[0].body.subarray(0, 5).toString(), '%PDF-');
  assert.equal(log.presigns[0].expiresIn, 86400);
  assert.equal(log.sends[0][0], '2348012345678', 'destination comes from the transaction owner, not job data');
  assert.match(log.sends[0][1], /https:\/\/s3\.example\/signed/);
  assert.equal(out.receiptId, 'SDA-tx1');
});

test('fails (for retry) on missing bucket, transaction or upload error', async () => {
  await assert.rejects(processReceiptJob({ data: { transactionId: 'tx1' } }, setup({ bucket: '' }).deps), /S3_RECEIPTS_BUCKET/);
  await assert.rejects(processReceiptJob({ data: {} }, setup().deps), /transactionId/);
  const missing = setup({ db: { transaction: { findUnique: async () => null } } });
  await assert.rejects(processReceiptJob({ data: { transactionId: 'x' } }, missing.deps), /not found/);
  const failing = setup({ upload: async () => { throw new Error('s3 down'); } });
  await assert.rejects(processReceiptJob({ data: { transactionId: 'tx1' } }, failing.deps), /s3 down/);
  assert.equal(failing.log.sends.length, 0, 'no link is sent when upload fails');
});

test('enqueue uses the receipts queue at priority 3 with an idempotent job id', async () => {
  const calls = [];
  await enqueueReceiptGeneration('tx1', { enqueue: async (...a) => { calls.push(a); } });
  const [queue, name, data, opts] = calls[0];
  assert.deepEqual([queue, name, data], ['receipts', 'receipt.generate', { transactionId: 'tx1' }]);
  assert.deepEqual(opts, { jobId: 'receipt-tx1', priority: 3 });
});
