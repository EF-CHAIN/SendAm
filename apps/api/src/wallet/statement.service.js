'use strict';

/**
 * Customer-Facing Balance and Transaction Export Service (#308)
 * ─────────────────────────────────────────────────────────────
 * Generates downloadable statements (CSV, PDF, JSON) for customer wallet
 * activity, fees, asset changes, and balance history with full audit metadata.
 */

const crypto = require('crypto');
const prisma = require('../common/prisma');
const walletService = require('./wallet.service');
const stellarAdapter = require('./stellar.adapter');
const { writeAuditLog } = require('../common/audit.service');
const { appendEvent, EVENT_TYPES } = require('../common/event.service');
const { assertValidAmount, add, subtract, formatUnits, getAssetRule, parseUnits } = require('../utils/money');

const escapeCsv = (value) => {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

/**
 * Pure JavaScript minimal PDF-1.4 generator for downloadable account statements.
 * Completely dependency-free and produces valid binary PDF documents.
 */
const buildPdfDocument = ({ title, metadata = [], summary = [], headers = [], rows = [] }) => {
  const objects = [];

  const addObject = (content) => {
    objects.push(content);
    return objects.length; // 1-based object number
  };

  // 1: Catalog
  addObject('<< /Type /Catalog /Pages 2 0 R >>');
  // 2: Pages
  addObject('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  // 3: Page (Letter: 612 x 792 pt)
  addObject('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>');
  // 4: Regular Font (Helvetica)
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // 5: Bold Font (Helvetica-Bold)
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  // Build stream content for the statement
  const lines = [];
  lines.push('BT');
  
  // Header title
  lines.push('/F2 18 Tf');
  lines.push('50 740 Td');
  lines.push(`(${escapePdf(title)}) Tj`);

  // Subtitle / Brand
  lines.push('/F1 10 Tf');
  lines.push('0 -16 Td');
  lines.push('(SendAm Direct-Custody Stellar Account Statement) Tj');

  // Metadata block
  lines.push('/F1 9 Tf');
  let currentY = 700;
  metadata.forEach((item) => {
    lines.push(`0 -14 Td`);
    lines.push(`(${escapePdf(item.label)}: ${escapePdf(item.value)}) Tj`);
    currentY -= 14;
  });

  // Summary box
  lines.push('0 -20 Td');
  lines.push('/F2 11 Tf');
  lines.push('(Activity & Balances Summary) Tj');
  lines.push('/F1 9 Tf');
  summary.forEach((item) => {
    lines.push(`0 -13 Td`);
    lines.push(`(${escapePdf(item.label)}: ${escapePdf(item.value)}) Tj`);
  });

  // Table header
  lines.push('0 -24 Td');
  lines.push('/F2 9 Tf');
  const headerLine = headers.join('   |   ');
  lines.push(`(${escapePdf(headerLine)}) Tj`);

  // Table separator
  lines.push('0 -8 Td');
  lines.push(`(${'-'.repeat(Math.min(headerLine.length + 10, 95))}) Tj`);

  // Table rows (up to 35 rows per page)
  lines.push('/F1 8 Tf');
  rows.slice(0, 35).forEach((row) => {
    lines.push('0 -12 Td');
    const rowStr = row.join('   |   ');
    lines.push(`(${escapePdf(rowStr.slice(0, 110))}) Tj`);
  });

  if (rows.length > 35) {
    lines.push('0 -14 Td');
    lines.push(`(... ${rows.length - 35} additional transactions truncated in preview; see CSV for full export) Tj`);
  }

  lines.push('ET');

  const streamContent = lines.join('\n');
  const streamLength = Buffer.byteLength(streamContent, 'utf-8');
  addObject(`<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream`);

  // Assemble PDF document with cross-reference table
  let output = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [0];

  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(output, 'utf-8'));
    output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(output, 'utf-8');
  output += `xref\n0 ${objects.length + 1}\n`;
  output += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    const offStr = String(offsets[i]).padStart(10, '0');
    output += `${offStr} 00000 n \n`;
  }

  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(output, 'utf-8');
};

const escapePdf = (str) => {
  if (!str) return '';
  return String(str).replace(/[\\()]/g, '\\$&');
};

/**
 * Fetch and construct raw statement data for a customer.
 */
const buildStatementData = async ({
  userId,
  startDate,
  endDate,
  asset,
}) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      wallets: {
        where: { chain: 'stellar' },
        take: 1,
      },
    },
  });

  if (!user) {
    const error = new Error('User account not found');
    error.statusCode = 404;
    throw error;
  }

  const wallet = user.wallets[0] || null;
  const where = {
    userId,
  };

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  if (asset) {
    where.asset = String(asset).trim().toUpperCase();
  }

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });

  // Current on-chain balances
  let liveBalances = [];
  if (wallet?.publicKey) {
    try {
      liveBalances = await stellarAdapter.getBalances(wallet.publicKey);
    } catch {
      liveBalances = [{ asset: 'XLM', value: '0' }, { asset: 'USDC', value: '0' }];
    }
  }

  // Calculate totals per asset
  const totalsByAsset = {};
  let totalFeeXlm = '0.0000000';

  transactions.forEach((tx) => {
    const txAsset = tx.asset || 'XLM';
    if (!totalsByAsset[txAsset]) {
      totalsByAsset[txAsset] = {
        sentCount: 0,
        sentAmount: '0.0000000',
        receivedCount: 0,
        receivedAmount: '0.0000000',
      };
    }

    const precision = getAssetRule(txAsset).precision;
    const amountStr = tx.amount || '0';

    if (tx.type === 'send') {
      totalsByAsset[txAsset].sentCount += 1;
      try {
        totalsByAsset[txAsset].sentAmount = add(totalsByAsset[txAsset].sentAmount, amountStr, txAsset);
      } catch {}
    } else if (tx.type === 'receive' || tx.type === 'deposit') {
      totalsByAsset[txAsset].receivedCount += 1;
      try {
        totalsByAsset[txAsset].receivedAmount = add(totalsByAsset[txAsset].receivedAmount, amountStr, txAsset);
      } catch {}
    }

    const fee = tx.metadata?.fee;
    if (fee) {
      try {
        totalFeeXlm = add(totalFeeXlm, String(fee), 'XLM');
      } catch {}
    }
  });

  const statementId = `STMT-${user.id.slice(-6).toUpperCase()}-${Date.now()}`;
  const periodStart = startDate ? new Date(startDate).toISOString() : (transactions[transactions.length - 1]?.createdAt?.toISOString() || new Date().toISOString());
  const periodEnd = endDate ? new Date(endDate).toISOString() : new Date().toISOString();

  return {
    statementId,
    generatedAt: new Date().toISOString(),
    user: {
      id: user.id,
      phoneNumber: user.phoneNumber,
      whatsappName: user.whatsappName,
      kycTier: user.kycTier,
    },
    wallet: wallet ? {
      publicKey: wallet.publicKey,
      chain: wallet.chain,
      network: wallet.network,
    } : null,
    period: {
      startDate: periodStart,
      endDate: periodEnd,
    },
    liveBalances,
    summary: totalsByAsset,
    totalFeesXlm: totalFeeXlm,
    transactionCount: transactions.length,
    transactions: transactions.map((t) => ({
      id: t.id,
      date: t.createdAt.toISOString(),
      type: t.type,
      asset: t.asset,
      amount: t.amount,
      fee: t.metadata?.fee || '0.0000000',
      fiatAmount: t.fiatAmount,
      fiatCurrency: t.fiatCurrency,
      status: t.status,
      rail: t.rail,
      routeType: t.routeType,
      destination: t.destination || t.recipientPhoneNumber || 'N/A',
      txHash: t.txHash || 'N/A',
      explorerUrl: t.explorerUrl || '',
      memo: t.metadata?.memo || '',
    })),
  };
};

/**
 * Generate CSV representation of statement.
 */
const exportStatementCsv = async ({ userId, startDate, endDate, asset, actingActor = { type: 'user', id: userId }, req }) => {
  const data = await buildStatementData({ userId, startDate, endDate, asset });

  const metadataHeaders = [
    `# SendAm Account Statement - ${data.statementId}`,
    `# Customer Phone: ${data.user.phoneNumber || 'N/A'}`,
    `# Wallet Address: ${data.wallet?.publicKey || 'N/A'}`,
    `# Period: ${data.period.startDate} to ${data.period.endDate}`,
    `# Generated At: ${data.generatedAt}`,
    `# Total Transactions: ${data.transactionCount}`,
  ].join('\n');

  const columns = [
    { header: 'Date', accessor: 'date' },
    { header: 'Transaction ID', accessor: 'id' },
    { header: 'Type', accessor: 'type' },
    { header: 'Asset', accessor: 'asset' },
    { header: 'Amount', accessor: 'amount' },
    { header: 'Fee', accessor: 'fee' },
    { header: 'Fiat Amount', accessor: (r) => r.fiatAmount || '' },
    { header: 'Fiat Currency', accessor: (r) => r.fiatCurrency || '' },
    { header: 'Status', accessor: 'status' },
    { header: 'Counterparty / Destination', accessor: 'destination' },
    { header: 'Tx Hash', accessor: 'txHash' },
    { header: 'Explorer URL', accessor: 'explorerUrl' },
  ];

  const headerRow = columns.map((c) => escapeCsv(c.header)).join(',');
  const bodyRows = data.transactions.map((row) =>
    columns.map((c) => escapeCsv(typeof c.accessor === 'function' ? c.accessor(row) : row[c.accessor])).join(','),
  ).join('\n');

  const csv = `${metadataHeaders}\n\n${headerRow}\n${bodyRows}\n`;

  await writeAuditLog({
    actorType: actingActor.type || 'user',
    actorId: String(actingActor.id || userId),
    action: 'wallet.statement.exported',
    entityType: 'User',
    entityId: String(userId),
    metadata: {
      statementId: data.statementId,
      format: 'csv',
      rowCount: data.transactions.length,
      period: data.period,
    },
    req,
  });

  return { csv, data, statementId: data.statementId };
};

/**
 * Generate PDF representation of statement.
 */
const exportStatementPdf = async ({ userId, startDate, endDate, asset, actingActor = { type: 'user', id: userId }, req }) => {
  const data = await buildStatementData({ userId, startDate, endDate, asset });

  const metadata = [
    { label: 'Statement ID', value: data.statementId },
    { label: 'Customer Phone', value: data.user.phoneNumber || 'N/A' },
    { label: 'Stellar Wallet', value: data.wallet?.publicKey ? `${data.wallet.publicKey.slice(0, 12)}...${data.wallet.publicKey.slice(-10)}` : 'N/A' },
    { label: 'Period', value: `${data.period.startDate.slice(0, 10)} to ${data.period.endDate.slice(0, 10)}` },
    { label: 'Generated At', value: data.generatedAt.slice(0, 19).replace('T', ' ') + ' UTC' },
  ];

  const summary = [
    { label: 'Current XLM Balance', value: data.liveBalances.find((b) => b.asset === 'XLM')?.value || '0.00' },
    { label: 'Current USDC Balance', value: data.liveBalances.find((b) => b.asset === 'USDC')?.value || '0.00' },
    { label: 'Total Transactions', value: String(data.transactionCount) },
    { label: 'Total Network Fees', value: `${data.totalFeesXlm} XLM` },
  ];

  const tableHeaders = ['Date', 'Type', 'Asset', 'Amount', 'Status', 'Tx Hash'];
  const tableRows = data.transactions.map((tx) => [
    tx.date.slice(0, 10),
    tx.type.toUpperCase(),
    tx.asset,
    tx.amount,
    tx.status.toUpperCase(),
    tx.txHash !== 'N/A' ? `${tx.txHash.slice(0, 8)}...` : 'N/A',
  ]);

  const pdfBuffer = buildPdfDocument({
    title: 'Account Statement',
    metadata,
    summary,
    headers: tableHeaders,
    rows: tableRows,
  });

  await writeAuditLog({
    actorType: actingActor.type || 'user',
    actorId: String(actingActor.id || userId),
    action: 'wallet.statement.exported',
    entityType: 'User',
    entityId: String(userId),
    metadata: {
      statementId: data.statementId,
      format: 'pdf',
      rowCount: data.transactions.length,
      period: data.period,
    },
    req,
  });

  return { pdfBuffer, data, statementId: data.statementId };
};

module.exports = {
  buildStatementData,
  exportStatementCsv,
  exportStatementPdf,
};
