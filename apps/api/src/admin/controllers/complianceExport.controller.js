const { readFile } = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const PDFDocument = require('pdfkit');
const { SignPdf } = require('@signpdf/signpdf');
const { P12Signer } = require('@signpdf/signer-p12');
const { pdfkitAddPlaceholder } = require('@signpdf/placeholder-pdfkit');
const { AppError } = require('../../errors/AppError');
const { classifyRiskScore, RISK_THRESHOLDS } = require('../../compliance/kycDecision.service');

const PDF_LIMIT = 1000;
const BATCH_SIZE = 500;
const fields = [
  'id', 'type', 'amount', 'asset', 'rail', 'status', 'destination',
  'recipientPhoneNumber', 'txHash', 'phoneNumber', 'createdAt',
  'userId', 'assetIssuer', 'fiatAmount', 'fiatCurrency', 'routeType', 'corridor',
  'riskScore', 'riskTier', 'quoteId', 'providerTransactionId', 'updatedAt',
];

const reportFilters = (query) => {
  const filters = [];
  if (query.corridor) {
    const corridor = String(query.corridor).trim();
    if (/^[a-z]{2}-[a-z]{2}$/i.test(corridor)) {
      filters.push({ metadata: { path: ['corridor'], equals: corridor.toUpperCase() } });
    } else if (['domestic', 'cross_border', 'unknown'].includes(corridor)) {
      filters.push({ routeType: corridor });
    } else {
      throw AppError.validation('Corridor must be a route type or country pair such as NG-GH.');
    }
  }

  const amountRange = {};
  for (const [param, operator] of [['minAmount', 'gte'], ['maxAmount', 'lte']]) {
    if (query[param] === undefined || query[param] === '') continue;
    if (typeof query[param] !== 'string' || !/^\d{1,30}(\.\d{1,18})?$/.test(query[param])) {
      throw AppError.validation(`${param} must be a nonnegative decimal amount.`);
    }
    amountRange[operator] = query[param];
  }
  if (Object.keys(amountRange).length) filters.push({ regulatoryAmount: amountRange });

  if (query.riskTier) {
    const { LOW_MAX, MEDIUM_MAX, HIGH_MAX, CRITICAL_MIN } = RISK_THRESHOLDS;
    const ranges = {
      low: { lte: LOW_MAX },
      medium: { gt: LOW_MAX, lte: MEDIUM_MAX },
      high: { gt: MEDIUM_MAX, lte: HIGH_MAX },
      critical: { gte: CRITICAL_MIN },
    };
    if (!Object.hasOwn(ranges, query.riskTier)) throw AppError.validation('Invalid transaction risk tier.');
    for (const [operator, value] of Object.entries(ranges[query.riskTier])) {
      filters.push({ metadata: { path: ['riskScore'], [operator]: value } });
    }
  }
  return filters.length ? { AND: filters } : {};
};

const reportRecord = (transaction) => ({
  ...transaction,
  phoneNumber: transaction.user?.phoneNumber,
  corridor: transaction.metadata?.corridor,
  riskScore: transaction.metadata?.riskScore,
  riskTier: typeof transaction.metadata?.riskScore === 'number' ? classifyRiskScore(transaction.metadata.riskScore) : '',
  createdAt: transaction.createdAt.toISOString(),
  updatedAt: transaction.updatedAt.toISOString(),
});

const csvField = (value) => {
  const raw = String(value ?? '');
  const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

async function* transactionRows(delegate, where) {
  let last;
  while (true) {
    const page = await delegate.findMany({
      where: last ? { AND: [where, { OR: [
        { createdAt: { lt: last.createdAt } },
        { createdAt: last.createdAt, id: { lt: last.id } },
      ] }] } : where,
      include: { user: { select: { phoneNumber: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: BATCH_SIZE,
    });
    yield* page.map(reportRecord);
    if (page.length < BATCH_SIZE) return;
    last = page.at(-1);
  }
}

async function* csvReport(rows) {
  yield `${fields.join(',')}\r\n`;
  for await (const row of rows) yield `${fields.map((field) => csvField(row[field])).join(',')}\r\n`;
}

const signedPdf = async (rows, signer, generatedAt, filters) => {
  const doc = new PDFDocument({ margin: 42, info: { Title: 'SendAm regulatory transaction report' } });
  const chunks = [];
  const buffer = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    doc.once('error', reject);
  });
  pdfkitAddPlaceholder({
    pdf: doc, reason: 'Regulatory transaction reporting',
    name: 'SendAm', contactInfo: '', location: '', signatureLength: 16384,
  });
  doc.fontSize(20).text('Regulatory transaction report');
  doc.moveDown().fontSize(10).text(`Generated ${generatedAt.toISOString()}`);
  doc.text(`Filters ${JSON.stringify(filters)}`).moveDown();
  doc.text(`${rows.length} transactions`).moveDown();
  for (const row of rows) {
    if (doc.y > 560) doc.addPage();
    doc.fontSize(11).text(`${row.id} | ${row.amount} ${row.asset} | ${row.status}`);
    doc.fontSize(8);
    for (const field of fields) if (row[field] != null && row[field] !== '') doc.text(`${field}  ${row[field]}`);
    doc.moveDown();
  }
  doc.end();
  return new SignPdf().sign(await buffer, signer);
};

const createComplianceExport = ({ prisma, writeAuditLog, transactionWhere }) => async (req, res, next) => {
  try {
    const { format = 'csv', ...filters } = req.query;
    if (format !== 'csv' && format !== 'pdf') throw AppError.validation('Report format must be csv or pdf.');
    for (const field of ['from', 'to']) {
      if (filters[field] && (typeof filters[field] !== 'string' || Number.isNaN(Date.parse(filters[field])))) {
        throw AppError.validation(`Invalid ${field} date.`);
      }
    }
    const generatedAt = new Date();
    const where = { AND: [transactionWhere(filters), { createdAt: { lte: generatedAt } }] };
    const rows = transactionRows(prisma.transaction, where);
    let pdf;
    if (format === 'pdf') {
      const certificate = process.env.COMPLIANCE_PDF_SIGNING_P12_PATH;
      if (!certificate) throw AppError.unavailable('PDF signing is unavailable.');
      const signer = new P12Signer(await readFile(certificate), {
        passphrase: process.env.COMPLIANCE_PDF_SIGNING_P12_PASSWORD || '',
      });
      const records = [];
      for await (const row of rows) {
        if (records.length >= PDF_LIMIT) throw AppError.validation(`Use CSV or narrow the filters to ${PDF_LIMIT} transactions for PDF.`);
        records.push(row);
      }
      pdf = await signedPdf(records, signer, generatedAt, filters);
    }
    await writeAuditLog({
      actorType: 'administrator',
      actorId: req.admin.id,
      action: 'admin.transactions.export',
      entityType: 'Transaction',
      metadata: { filters, format },
      req,
    });
    res.setHeader('Content-Disposition', `attachment; filename="transactions-export.${format}"`);
    if (pdf) return res.type('application/pdf').send(pdf);
    res.type('text/csv; charset=utf-8');
    await pipeline(Readable.from(csvReport(rows)), res);
  } catch (error) {
    if (!res.destroyed) return next(error);
  }
};

module.exports = { createComplianceExport, reportFilters, transactionRows, csvReport, signedPdf };
