const { formatUnits, parseUnits, percentage, subtract, compare } = require('../utils/money');
const { calculateQuoteFee } = require('./feeRule.service');

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLDS = {
  XLM: [100, 1000],
  USDC: [100, 1000],
  NGN: [100_000, 1_000_000],
  GHS: [1000, 10_000],
};
const TIERS = [
  { name: 'gold', discountBps: 2500, cashbackBps: 1000 },
  { name: 'silver', discountBps: 1000, cashbackBps: 500 },
  { name: 'standard', discountBps: 0, cashbackBps: 0 },
];

const availableVoucher = {
  earnedBy: { status: 'success' },
  OR: [{ redeemedById: null }, { redeemedBy: { status: { in: ['failed', 'expired', 'cancelled'] } } }],
};

// `detail: true` additionally returns the fee-rule breakdown so the caller can
// persist which corridor rule priced the quote. The default return shape stays
// `{ fee }` / `{ fee, loyalty }` for existing callers.
const priceLoyaltyFee = async ({ db, userId, asset, amount, targetCurrency, now = new Date(), detail = false }) => {
  // The base fee comes from the corridor fee schedule (#997): a percentage plus
  // a fixed cost, clamped between the corridor floor and cap so small payments
  // still cover the Stellar/off-ramp charges. Loyalty discounts and vouchers
  // are applied on top of that base.
  const feeQuote = await calculateQuoteFee({
    db,
    asset,
    amount,
    sourceCurrency: asset,
    targetCurrency: targetCurrency || asset,
  });
  const baseFee = feeQuote.fee;
  if (!userId || !THRESHOLDS[asset] || !db.feeVoucher) {
    return detail ? { fee: baseFee, feeQuote } : { fee: baseFee };
  }

  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const payments = await db.transaction.findMany({
    where: { userId, type: 'send', status: 'success', asset, updatedAt: { gte: cutoff } },
    select: { amount: true, metadata: true, updatedAt: true },
  });
  const precision = 7; // All supported Stellar assets can settle at stroop precision.
  const volume = payments.reduce((sum, payment) => {
    const confirmedAt = new Date(payment.metadata?.confirmedAt || payment.updatedAt);
    if (!(confirmedAt >= cutoff && confirmedAt <= now)) return sum;
    const path = payment.metadata?.pathPayment;
    return sum + parseUnits(path ? path.sourceDebit || '0' : payment.amount, precision);
  }, 0n);

  const tierIndex = THRESHOLDS[asset].findLastIndex((minimum) => volume >= parseUnits(minimum, precision));
  const tier = TIERS[1 - tierIndex];
  const discountedFee = subtract(baseFee, percentage(baseFee, asset, tier.discountBps), asset);
  const vouchers = compare(discountedFee, '0', asset) > 0
    ? await db.feeVoucher.findMany({
      where: { userId, asset, ...availableVoucher },
      orderBy: [{ createdAt: 'asc' }, { earnedById: 'asc' }],
      select: { earnedById: true, amount: true },
    })
    : [];
  const voucher = vouchers.find((entry) => compare(entry.amount, discountedFee, asset) <= 0);
  const fee = voucher ? subtract(discountedFee, voucher.amount, asset) : discountedFee;
  const result = {
    fee,
    loyalty: {
      tier: tier.name,
      volume: formatUnits(volume, precision),
      discountBps: tier.discountBps,
      rewardAmount: percentage(fee, asset, tier.cashbackBps),
      ...(voucher ? { voucherId: voucher.earnedById, voucherAmount: voucher.amount } : {}),
    },
  };
  return detail ? { ...result, feeQuote } : result;
};

const redeemVoucher = async ({ db, transaction, loyalty }) => {
  if (!loyalty?.voucherId) return;
  const result = await db.feeVoucher.updateMany({
    where: {
      earnedById: loyalty.voucherId,
      userId: transaction.userId,
      asset: transaction.asset,
      ...availableVoucher,
    },
    data: { redeemedById: transaction.id },
  });
  if (result.count !== 1) {
    throw Object.assign(new Error('This fee voucher has already been applied. Request a new quote.'), { statusCode: 409 });
  }
};

const hasLoyaltyReward = (transaction) => {
  const amount = transaction.metadata?.loyalty?.rewardAmount;
  return transaction.type === 'send' && Boolean(amount) && compare(amount, '0', transaction.asset) > 0;
};

const creditVoucher = async ({ db, transaction }) => {
  if (!hasLoyaltyReward(transaction)) return;
  const { rewardAmount: amount } = transaction.metadata.loyalty;
  await db.feeVoucher.upsert({
    where: { earnedById: transaction.id },
    create: { earnedById: transaction.id, userId: transaction.userId, asset: transaction.asset, amount },
    update: {},
  });
};

module.exports = { priceLoyaltyFee, redeemVoucher, creditVoucher, hasLoyaltyReward };
