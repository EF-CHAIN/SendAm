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

  const compliance = await enforceTransactionPolicy({
    user: senderUser,
    amount,
    routeType: effectiveRouteType,
    destinationCountry,
  });
  const quote = await createQuote({
    userId: senderUser.id,
    sourceCurrency: effectiveAsset,
    targetCurrency: effectiveAsset,
    sourceAmount: amount,
    route: rail,
    provider: rail,
  });

  let transaction = await prisma.transaction.create({
    data: {
      userId: senderUser.id,
      type: 'send',
      amount: String(amount),
      asset: effectiveAsset,
      recipientPhoneNumber,
      destination,
      rail,
      routeType: effectiveRouteType,
      quoteId: quote.id,
      status: 'processing',
      metadata: {
        fee: calculateFee(amount),
        userHiddenRail: true,
        riskScore: compliance.riskScore,
      },
    },
  });

  try {
    const wallet = await walletService.createOrGetWallet({ user: senderUser });
    const result = await walletService.submitPayment({ wallet, destination, amount, asset: effectiveAsset });
    transaction = await prisma.transaction.update({
      where: { id: transaction.id },
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
      entityId: String(transaction.id),
      metadata: { rail, status: transaction.status },
    });

    return { transaction: withIdAlias(transaction), quote, receipt: buildReceipt({ transaction }) };
  } catch (error) {
    // Guarded: if this bookkeeping update itself rejects, the original
    // payment error is still the one thrown to the caller.
    await markTransactionFailed({
      prisma,
      transactionId: transaction.id,
      metadata: transaction.metadata,
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
