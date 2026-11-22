const { add, formatUnits, getAssetRule, parseUnits } = require('../utils/money');

const SYSTEM_USER = 'system';
const defaultPrisma = () => require('../common/prisma');

const signedUnits = (amount, precision) => {
  const raw = String(amount || '').trim();
  const sign = raw.startsWith('-') ? -1n : 1n;
  const abs = raw.replace(/^-/, '');
  return sign * parseUnits(abs, precision);
};

const assertBalancedPostings = (postings) => {
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new Error('A journal entry requires at least two postings.');
  }
  const totals = new Map();
  for (const posting of postings) {
    const asset = getAssetRule(posting.asset);
    const precision = posting.precision ?? asset.precision;
    const units = signedUnits(posting.amount, precision) * 10n ** BigInt(7 - precision);
    totals.set(asset.code, (totals.get(asset.code) || 0n) + units);
  }
  for (const [asset, total] of totals.entries()) {
    if (total !== 0n) {
      throw new Error(`Journal entry is unbalanced for ${asset}: ${formatUnits(total, 7)}`);
    }
  }
  return true;
};

const accountKey = ({ type, asset, userId = SYSTEM_USER }) => `${type}:${asset}:${userId}`;

const ensureAccount = async (tx, { type, asset, userId }) => {
  const key = accountKey({ type, asset, userId });
  const existing = await tx.ledgerAccount.findUnique({ where: { key } });
  if (existing) return existing;
  try {
    return await tx.ledgerAccount.create({
      data: {
        key,
        type,
        asset,
        userId: userId === SYSTEM_USER ? null : String(userId),
      },
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      return tx.ledgerAccount.findUnique({ where: { key } });
    }
    throw error;
  }
};

const createJournalEntry = async ({
  tx,
  eventType,
  transactionId,
  externalRef,
  metadata = {},
  postings,
}) => {
  const client = tx || defaultPrisma();
  if (!client?.journalEntry || !client?.ledgerAccount || !client?.ledgerPosting) return null;

  const normalized = postings.map((posting) => {
    const asset = getAssetRule(posting.asset);
    const precision = posting.precision ?? asset.precision;
    return { ...posting, asset: asset.code, amount: formatUnits(signedUnits(posting.amount, precision), precision) };
  });
  assertBalancedPostings(normalized);

  const accounts = new Map();
  for (const posting of normalized) {
    const key = accountKey(posting);
    if (!accounts.has(key)) accounts.set(key, await ensureAccount(client, posting));
  }

  return client.journalEntry.create({
    data: {
      eventType,
      transactionId,
      externalRef,
      metadata,
      postings: {
        create: normalized.map((posting) => ({
          accountId: accounts.get(accountKey(posting)).id,
          asset: posting.asset,
          amount: posting.amount,
        })),
      },
    },
    include: { postings: true },
  });
};

const totalCharge = (transaction) => {
  const fee = transaction.metadata?.fee || '0';
  return add(transaction.amount, fee, transaction.asset);
};

const postPaymentReserved = ({ tx, transaction }) => createJournalEntry({
  tx,
  eventType: 'payment.reserved',
  transactionId: transaction.id,
  metadata: { status: transaction.status, quoteId: transaction.quoteId, fee: transaction.metadata?.fee },
  postings: [
    { type: 'customer_money', userId: transaction.userId, asset: transaction.asset, amount: `-${totalCharge(transaction)}` },
    { type: 'stellar_pending', asset: transaction.asset, amount: transaction.amount },
    { type: 'fee_revenue', asset: transaction.asset, amount: transaction.metadata?.fee || '0' },
  ],
});

const postPaymentSettled = ({ tx, transaction }) => {
  const debit = transaction.metadata?.pathPayment?.sourceDebit;
  const amount = debit || transaction.amount;
  const precision = debit ? 7 : undefined;
  return createJournalEntry({
    tx,
    eventType: 'payment.settled',
    transactionId: transaction.id,
    externalRef: transaction.txHash,
    metadata: { status: transaction.status, explorerUrl: transaction.explorerUrl },
    postings: [
      { type: 'stellar_pending', asset: transaction.asset, amount: `-${amount}`, precision },
      { type: 'stellar_settled', asset: transaction.asset, amount, precision },
    ],
  });
};

const postPaymentFailed = ({ tx, transaction }) => createJournalEntry({
  tx,
  eventType: 'payment.failed_reversal',
  transactionId: transaction.id,
  metadata: { status: transaction.status, fee: transaction.metadata?.fee },
  postings: [
    { type: 'stellar_pending', asset: transaction.asset, amount: `-${transaction.amount}` },
    { type: 'fee_revenue', asset: transaction.asset, amount: `-${transaction.metadata?.fee || '0'}` },
    { type: 'customer_money', userId: transaction.userId, asset: transaction.asset, amount: totalCharge(transaction) },
  ],
});

const postRefundSettled = ({ tx, transaction, originalTransactionId }) => createJournalEntry({
  tx,
  eventType: 'refund.settled',
  transactionId: transaction.id,
  externalRef: transaction.txHash,
  metadata: { originalTransactionId, status: transaction.status },
  postings: [
    { type: 'stellar_settled', asset: transaction.asset, amount: `-${transaction.amount}` },
    { type: 'customer_money', userId: transaction.userId, asset: transaction.asset, amount: transaction.amount },
  ],
});

module.exports = {
  assertBalancedPostings,
  createJournalEntry,
  postPaymentReserved,
  postPaymentSettled,
  postPaymentFailed,
  postRefundSettled,
};
