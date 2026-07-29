const walletService = require('../wallet/wallet.service');
const { validateAddress } = require('../wallet/stellar.adapter');
const { createQuote } = require('../pricing/pricing.service');
const { writeAuditLog } = require('../common/audit.service');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { markTransactionFailed } = require('./markFailed');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');

const calculateFee = (amount) => {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return '0';
  return (parsed * 0.01).toFixed(2);
};

const buildReceipt = ({ transaction }) => {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    amount: transaction.amount,
    asset: transaction.asset,
    rail: transaction.rail,
    receiptUrl: transaction.explorerUrl,
  };
};

// Stellar-only: every payment settles on Stellar. routeType survives as a
// compliance/reporting label computed from the countries involved.
const RAIL = 'stellar';
const NATIVE_ASSET = 'XLM';

const executePayment = async ({
  sender,
  recipientPhoneNumber,
  destination,
  amount,
  asset,
  sourceCountry = 'NG',
  destinationCountry = 'NG',
  routeType,
}) => {
  const senderUser = sender;
  if (!senderUser) throw new Error('Sender not found.');

  if (destination && !validateAddress(String(destination).trim())) {
    throw new Error('Destination must be a valid Stellar address.');
  }

  const rail = RAIL;
  // Direct custody only supports the native asset for now (see
  // wallet/stellar.adapter.js resolveAsset) — no anchor-asset support yet.
  const effectiveAsset = asset || NATIVE_ASSET;
  const effectiveRouteType = routeType
    || (sourceCountry && destinationCountry && sourceCountry !== destinationCountry ? 'cross_border' : 'domestic');

  const { quote, transaction } = await (prisma.$transaction ? prisma.$transaction(async (tx) => {
    const comp = await enforceTransactionPolicy({
      user: senderUser,
      amount,
      routeType: effectiveRouteType,
      destinationCountry,
      tx,
    });
    const q = await createQuote({
      userId: senderUser.id,
      sourceCurrency: effectiveAsset,
      targetCurrency: effectiveAsset,
      sourceAmount: amount,
      route: rail,
      provider: rail,
    });
    const t = await tx.transaction.create({
      data: {
        userId: senderUser.id,
        type: 'send',
        amount: String(amount),
        asset: effectiveAsset,
        recipientPhoneNumber,
        destination,
        rail,
        routeType: effectiveRouteType,
        quoteId: q.id,
        status: 'processing',
        metadata: {
          fee: calculateFee(amount),
          userHiddenRail: true,
          riskScore: comp.riskScore,
        },
      },
    });
    return { compliance: comp, quote: q, transaction: t };
  }) : (async () => {
    const comp = await enforceTransactionPolicy({
      user: senderUser,
      amount,
      routeType: effectiveRouteType,
      destinationCountry,
      tx: prisma,
    });
    const q = await createQuote({
      userId: senderUser.id,
      sourceCurrency: effectiveAsset,
      targetCurrency: effectiveAsset,
      sourceAmount: amount,
      route: rail,
      provider: rail,
    });
    const t = await prisma.transaction.create({
      data: {
        userId: senderUser.id,
        type: 'send',
        amount: String(amount),
        asset: effectiveAsset,
        recipientPhoneNumber,
        destination,
        rail,
        routeType: effectiveRouteType,
        quoteId: q.id,
        status: 'processing',
        metadata: {
          fee: calculateFee(amount),
          userHiddenRail: true,
          riskScore: comp.riskScore,
        },
      },
    });
    return { compliance: comp, quote: q, transaction: t };
  })());

  let activeTransaction = transaction;

  try {
    const wallet = await walletService.createOrGetWallet({ user: senderUser });
    const result = await walletService.submitPayment({ wallet, destination, amount, asset: effectiveAsset });
    activeTransaction = await prisma.transaction.update({
      where: { id: activeTransaction.id },
      data: {
        status: 'success',
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
      },
    });

    await writeAuditLog({
      actorType: 'user',
      actorId: String(senderUser.id),
      action: 'payment.executed',
      entityType: 'Transaction',
      entityId: String(activeTransaction.id),
      metadata: { rail, status: activeTransaction.status },
    });

    return { transaction: withIdAlias(activeTransaction), quote, receipt: buildReceipt({ transaction: activeTransaction }) };
  } catch (error) {
    // Guarded: if this bookkeeping update itself rejects, the original
    // payment error is still the one thrown to the caller.
    await markTransactionFailed({
      prisma,
      transactionId: activeTransaction.id,
      metadata: activeTransaction.metadata,
      error,
    });
    throw error;
  }
};

module.exports = {
  executePayment,
  calculateFee,
  buildReceipt,
};
