'use strict';

// Background PDF receipt generation (#1014).
//
// Rendering a PDF in the HTTP/webhook request path burns CPU and delays the
// WhatsApp reply, so the reply goes out immediately and this job produces the
// PDF afterwards: render (PDFKit) -> upload (S3, private, SSE) -> presign a
// short-lived GET URL (24h) -> send the link over WhatsApp.
//
// The job runs on the `receipts` queue at priority 3 (see queues/priorityQueues.js),
// so urgent payment work is never starved by receipt rendering.

const PDFDocument = require('pdfkit');
const config = require('../config/env');
const logger = require('../utils/logger');
const { increment, observeDuration } = require('../observability/metrics');
const { buildStandardReceipt } = require('../services/receipt.service');

const QUEUE_NAME = 'receipts';
const JOB_NAME = 'receipt.generate';
const DEFAULT_URL_TTL_SECONDS = 24 * 60 * 60;

/** Render a receipt to an in-memory PDF buffer. Pure: no I/O besides the stream. */
const renderReceiptPdf = (receipt) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A5', margin: 40, info: { Title: `SendAm receipt ${receipt.receiptId}`, Author: 'SendAm' } });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);

  doc.fontSize(20).text('SendAm Payment Receipt', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#555555').text(receipt.receiptId, { align: 'center' });
  doc.moveDown();
  doc.fillColor('#000000').fontSize(12);

  const rows = [
    ['Status', receipt.status],
    ['Amount', `${receipt.amount} ${receipt.asset}`],
    ['Fee', `${receipt.fee} ${receipt.asset}`],
    ['From', receipt.sender || 'N/A'],
    ['To', receipt.recipient || 'N/A'],
    ['Date', receipt.timestamp],
    ['Transaction', receipt.transactionHash],
  ];
  if (receipt.metadata?.memo) rows.push(['Memo', receipt.metadata.memo]);
  for (const [label, value] of rows) {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
    doc.font('Helvetica').text(String(value));
    doc.moveDown(0.3);
  }
  doc.moveDown();
  doc.fontSize(9).fillColor('#555555').text(`Verify: ${receipt.receiptUrl}`, { link: receipt.receiptUrl });
  doc.end();
});

let cachedS3;
const defaultS3 = () => {
  if (!cachedS3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    cachedS3 = new S3Client({ region: config.receipts?.region });
  }
  return cachedS3;
};

const defaultUpload = async ({ bucket, key, body }) => {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await defaultS3().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'AES256',
    CacheControl: 'private, max-age=0, no-store',
  }));
};

const defaultPresign = async ({ bucket, key, expiresIn }) => {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(defaultS3(), new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentType: 'application/pdf',
    ResponseContentDisposition: 'attachment; filename="sendam-receipt.pdf"',
  }), { expiresIn });
};

const objectKeyFor = (receipt) => `receipts/${receipt.receiptId}.pdf`;

/**
 * Queue processor. Dependencies are injectable so the pipeline is testable
 * without AWS or WhatsApp. Throws on any failure so BullMQ retries.
 */
const processReceiptJob = async (job, deps = {}) => {
  const db = deps.db || require('../common/prisma');
  const upload = deps.upload || defaultUpload;
  const presign = deps.presign || defaultPresign;
  const send = deps.sendMessage || require('../services/whatsapp.service').sendTextMessage;
  const bucket = deps.bucket || config.receipts?.bucket;
  const expiresIn = deps.urlTtlSeconds || config.receipts?.urlTtlSeconds || DEFAULT_URL_TTL_SECONDS;

  if (!bucket) throw new Error('S3_RECEIPTS_BUCKET is not configured');
  const { transactionId } = job.data || {};
  if (!transactionId) throw new Error('receipt job requires transactionId');

  const started = process.hrtime.bigint();
  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    include: { user: true },
  });
  if (!transaction) throw new Error(`Transaction ${transactionId} not found`);
  // The destination always comes from the owning user, never from job data.
  const phoneNumber = transaction.user?.phoneNumber;
  if (!phoneNumber) throw new Error(`Transaction ${transactionId} has no deliverable owner`);

  const receipt = buildStandardReceipt(transaction, { mask: true });
  const pdf = await renderReceiptPdf(receipt);
  const key = objectKeyFor(receipt);
  await upload({ bucket, key, body: pdf });
  const url = await presign({ bucket, key, expiresIn });

  const hours = Math.round(expiresIn / 3600);
  await send(phoneNumber, `Your PDF receipt (${receipt.receiptId}) is ready:\n${url}\n\nThis link expires in ${hours} hours.`, {
    notification: {
      userId: transaction.userId,
      type: 'transaction_receipt',
      referenceType: 'transaction',
      referenceId: transaction.id,
    },
  });

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  observeDuration('sendam_receipt_pdf_seconds', {}, seconds);
  increment('sendam_receipt_pdf_total', { status: 'delivered' });
  logger.info('receipt_pdf_delivered', { transactionId, receiptId: receipt.receiptId, bytes: pdf.length, seconds });
  return { receiptId: receipt.receiptId, key, bytes: pdf.length };
};

/** Queue a receipt for background generation at receipt priority. */
const enqueueReceiptGeneration = (transactionId, deps = {}) => {
  const { enqueuePrioritized } = require('../queues/priorityQueues');
  return enqueuePrioritized(QUEUE_NAME, JOB_NAME, { transactionId }, 'receipts', {
    jobId: `receipt-${transactionId}`,
  }, deps.enqueue);
};

module.exports = {
  QUEUE_NAME,
  JOB_NAME,
  renderReceiptPdf,
  processReceiptJob,
  enqueueReceiptGeneration,
  objectKeyFor,
};
