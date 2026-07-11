const walletService = require('../wallet/wallet.service');
const { detectChainFromAddress } = require('../wallet/chainRegistry');
const { selectRail } = require('../blockchain/railSelector');
const { createQuote } = require('../pricing/pricing.service');
const { writeAuditLog } = require('../common/audit.service');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
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

const NATIVE_ASSET_BY_RAIL = { stellar: 'XLM', lisk: 'ETH' };
const RAILS_WITH_NO_DESTINATION_CHAIN = ['cash_in', 'cash_out', 'escrow'];

const executePayment = async ({
  sender,
  recipientPhoneNumber,
  destination,
  amount,
  asset,
  sourceCountry = 'NG',
  destinationCountry = 'NG',
  routeType,
  forceRail,
}) => {
  const senderUser = sender;
  if (!senderUser) throw new Error('Sender not found.');

  // A destination address decides which chain a plain P2P send uses — the
  // user never declares a chain. Ramp/escrow routes have no on-chain
  // destination to detect a chain from, so they keep selectRail's existing
  // routeType-based precedence untouched.
  let effectiveForceRail = forceRail;
  if (!effectiveForceRail && destination && !RAILS_WITH_NO_DESTINATION_CHAIN.includes(routeType)) {
    const detectedChain = detectChainFromAddress(destination);
    if (detectedChain) effectiveForceRail = detectedChain;
  }

  const rail = selectRail({ sourceCountry, destinationCountry, routeType, forceRail: effectiveForceRail });
  // Direct custody only supports each chain's native asset for now (see
  // wallet/stellar.adapter.js and wallet/lisk.adapter.js resolveAsset) — no
  // ERC-20/anchor-asset support yet. Fiat ramp rails aren't chain-native, so
  // they keep the USDC default.
  const effectiveAsset = asset || NATIVE_ASSET_BY_RAIL[rail] || 'USDC';

  const compliance = await enforceTransactionPolicy({
    user: senderUser,
    amount,
    routeType: routeType || (rail === 'stellar' ? 'cross_border' : 'domestic'),
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
      type: routeType === 'escrow' ? 'escrow_create' : 'send',
      amount: String(amount),
      asset: effectiveAsset,
      recipientPhoneNumber,
      destination,
      rail,
      routeType: routeType || (rail === 'stellar' ? 'cross_border' : 'domestic'),
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
    if (rail === 'lisk' || rail === 'stellar') {
      const wallet = await walletService.createOrGetWallet({ user: senderUser, chain: rail });
      const result = await walletService.submitPayment({ wallet, destination, amount, asset: effectiveAsset });
      transaction = await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'success',
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
        },
      });
    } else {
      transaction = await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'pending',
          metadata: {
            ...transaction.metadata,
            rampProvider: rail,
            note: 'Fiat ramp provider execution is queued for provider-specific settlement.',
          },
        },
      });
    }

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
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'failed',
        metadata: { ...transaction.metadata, error: error.message },
      },
    });
    throw error;
  }
};

module.exports = {
  executePayment,
  calculateFee,
  buildReceipt,
};
