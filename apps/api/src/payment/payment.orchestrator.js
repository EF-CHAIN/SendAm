const walletService = require('../wallet/wallet.service');
const stellarAdapter = require('../wallet/stellar.adapter');
const { createQuote, validateQuoteForExecution, QUOTE_STATUS } = require('../pricing/pricing.service');
const { isFirmSep38Quote, assertFirmQuoteValidForExecution } = require('../pricing/quote.service');
const { writeAuditLog } = require('../common/audit.service');
const { appendEvent, EVENT_TYPES } = require('../common/event.service');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { evaluateTransactionRisk, assertRiskAllowsPayment } = require('../compliance/riskEngine');
const { assertAccountActive } = require('../compliance/account.service');
const { markTransactionFailed } = require('./markFailed');
const { transitionPaymentState } = require('./payment.transitions');
const { handleStellarPaymentFailure } = require('./refundEngine');
const ledger = require('./ledger.service');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');
const { assertValidAmount, percentage } = require('../utils/money');
const config = require('../config/env');
const assetIdentity = require('../wallet/assetIdentity');
const { pathAmount } = require('./pathPaymentRouter');
const { redeemVoucher, hasLoyaltyReward } = require('../pricing/loyaltyRebate');

const RAIL = 'stellar';
const NATIVE_ASSET = 'XLM';
const ELIGIBLE_REASONS = ['failed_fulfillment', 'operator_mistake', 'customer_request', 'duplicate_payment'];

const calculateFee = (amount, asset = NATIVE_ASSET) => percentage(assertValidAmount(amount, asset), asset, 100);

const buildReceipt = ({ transaction }) => {
  const meta = transaction.metadata || {};
  return {
    transactionId: transaction.id,
    receiptId: `SDA-${transaction.id}`,
    status: transaction.status,
    amount: meta.pathPayment?.sourceDebit || transaction.amount,
    asset: transaction.asset,
    rail: transaction.rail,
    receiptUrl: transaction.explorerUrl,
    ...(meta.pathPayment ? { pathPayment: meta.pathPayment } : {}),
    ...(meta.loyalty ? { loyalty: meta.loyalty } : {}),
    ...(meta.fee ? { fee: meta.fee } : {}),
    ...(meta.memo ? { memo: meta.memo, memoType: meta.memoType || 'text' } : {}),
  };
};

const runDbTransaction = (fn) => (prisma.$transaction ? prisma.$transaction(fn) : fn(prisma));

const executePayment = async ({
  sender,
  recipientPhoneNumber,
  destination,
  amount,
  asset,
  targetCurrency,
  sourceCountry = 'NG',
  destinationCountry = 'NG',
  routeType,
  transactionId,
  memo,
  memoType,
  quoteId,
  idempotencyKey,
  destinationAsset,
  destinationAmount,
  // Channel-provided risk signals (#992): { ip, deviceInfo, stepUpVerified }.
  // WhatsApp traffic has none; web/app channels pass what they have.
  riskSignals = {},
}) => {
  const senderUser = sender;
  if (!senderUser) throw new Error('Sender not found.');
  assertAccountActive(senderUser);

  if (destination && !stellarAdapter.validateAddress(String(destination).trim())) {
    throw new Error('Destination must be a valid Stellar address.');
  }

  if (destination && stellarAdapter.isMuxedAddress && stellarAdapter.isMuxedAddress(destination) && memo !== undefined && memo !== null && memo !== '') {
    throw new Error('Muxed account destination already includes an embedded ID; providing a separate memo is conflicting.');
  }

  if (memo !== undefined && memo !== null && memo !== '') {
    stellarAdapter.validateMemo({ memo, memoType });
  }

  const rail = RAIL;
  const effectiveAsset = asset || NATIVE_ASSET;
  const effectiveRouteType = routeType || (sourceCountry && destinationCountry && sourceCountry !== destinationCountry ? 'cross_border' : 'domestic');
  const normalizedAmount = assertValidAmount(amount, effectiveAsset);

  let pathPayment;
  if (destinationAsset !== undefined || destinationAmount !== undefined) {
    if (!destinationAsset || !destinationAmount || destinationAsset === effectiveAsset) {
      throw Object.assign(new Error('A different destination asset and its exact receive amount are required.'), { statusCode: 400 });
    }
    stellarAdapter.resolveAsset(effectiveAsset, { path: true });
    const target = stellarAdapter.resolveAsset(destinationAsset, { path: true });
    pathAmount(destinationAmount);
    pathPayment = { destinationAsset, destinationAmount, destinationIssuer: target.getIssuer() || null };
  }

  const memoMetadata = (memo !== undefined && memo !== null && memo !== '')
    ? { memo: stellarAdapter.redactMemo ? stellarAdapter.redactMemo(memo) : String(memo), memoType: String(memoType || 'text').toLowerCase() }
    : {};

  // Dynamic risk scoring runs before the DB transaction: it may call out to
  // IP-reputation sources and must not hold the transaction open meanwhile.
  const riskAssessment = await evaluateTransactionRisk({
    userId: senderUser.id,
    phoneNumber: senderUser.phoneNumber,
    ip: riskSignals.ip,
    deviceInfo: riskSignals.deviceInfo,
    destinationCountry,
    amount: normalizedAmount,
    asset: effectiveAsset,
    routeType: effectiveRouteType,
  });
  assertRiskAllowsPayment(riskAssessment, { stepUpVerified: riskSignals.stepUpVerified === true });

  // Core runs inside a single Prisma transaction so the quote and the payment
  // reservation commit together (or not at all).
  const runCore = async (tx) => {
    const compliance = await enforceTransactionPolicy({
      user: senderUser,
      amount: normalizedAmount,
      asset: effectiveAsset,
      routeType: effectiveRouteType,
      destinationCountry,
      recipientPhoneNumber,
      destination,
      tx,
    });

    // Idempotency short-circuit: an earlier attempt with this key already
    // reserved a transaction. Return it (and its quote) without creating
    // duplicates or re-consuming a quote.
    if (idempotencyKey) {
      const prior = await tx.transaction.findUnique({ where: { idempotencyKey } });
      if (prior) {
        const quote = prior.quoteId ? await tx.quote.findUnique({ where: { id: prior.quoteId } }) : null;
        return { quote, transaction: prior, created: false };
      }
    }

    let quote;
    if (quoteId) {
      const existing = await tx.quote.findUnique({ where: { id: quoteId } });
      if (isFirmSep38Quote(existing)) {
        assertFirmQuoteValidForExecution({
          quote: existing,
          userId: senderUser.id,
          sourceAsset: effectiveAsset,
          targetAsset: targetCurrency || null,
          amount: normalizedAmount,
        });
      } else {
        await validateQuoteForExecution({
          quote: existing,
          userId: senderUser.id,
          asset: effectiveAsset,
          amount: normalizedAmount,
        });
      }
      // Safe to settle: claim the quote so a retry with the same id is rejected.
      quote = await tx.quote.update({
        where: { id: quoteId, status: QUOTE_STATUS.ACTIVE },
        data: { status: QUOTE_STATUS.CONSUMED },
      });
    } else {
      quote = await createQuote({
        userId: senderUser.id,
        sourceCurrency: effectiveAsset,
        targetCurrency: effectiveAsset,
        sourceAmount: normalizedAmount,
        route: rail,
        provider: rail,
        tx,
      });
    }

    const sep38Metadata = isFirmSep38Quote(quote) ? {
      sep38Quote: {
        quoteId: quote.id,
        anchorQuoteId: quote.metadata?.sep38?.anchorQuoteId || null,
        sellAsset: quote.metadata?.sep38?.sellAsset || quote.sourceCurrency,
        buyAsset: quote.metadata?.sep38?.buyAsset || quote.targetCurrency,
        sellAmount: quote.sourceAmount,
        buyAmount: quote.targetAmount,
        price: quote.metadata?.sep38?.price || null,
        totalPrice: quote.rate || quote.metadata?.sep38?.totalPrice || null,
        expiresAt: quote.expiresAt ? new Date(quote.expiresAt).toISOString() : null,
      },
    } : {};

    let transaction;
    try {
      transaction = await tx.transaction.create({
        data: {
          ...(transactionId ? { id: transactionId } : {}),
          userId: senderUser.id,
          type: 'send',
          amount: normalizedAmount,
          asset: effectiveAsset,
          assetIssuer: assetIdentity.resolveConfiguredIssuer({
            network: config.stellar.network,
            code: effectiveAsset,
          }),
          recipientPhoneNumber,
          destination,
          rail,
          routeType: effectiveRouteType,
          quoteId: quote.id,
          idempotencyKey,
          status: 'processing',
          fiatCurrency: compliance.policySnapshot?.referenceCurrency || (isFirmSep38Quote(quote) ? quote.targetCurrency : undefined),
          fiatAmount: compliance.policySnapshot?.convertedAmount || (isFirmSep38Quote(quote) ? quote.targetAmount : undefined),
          metadata: {
            fee: quote.fee ?? calculateFee(normalizedAmount, effectiveAsset),
            ...(quote.metadata?.loyalty ? { loyalty: quote.metadata.loyalty } : {}),
            ...(pathPayment ? { pathPayment } : {}),
            userHiddenRail: true,
            riskScore: compliance.riskScore,
            ...(sourceCountry && destinationCountry
              ? { corridor: `${sourceCountry}-${destinationCountry}`.toUpperCase() } : {}),
            stateHistory: [{
              from: null,
              to: 'processing',
              actor: { type: 'user', id: String(senderUser.id) },
              timestamp: new Date().toISOString(),
              reason: 'Payment transaction created',
            }],
            ...(compliance.policySnapshot ? {
              policy: {
                version: compliance.policySnapshot.policyVersion,
                rate: compliance.policySnapshot.rate,
                source: compliance.policySnapshot.source,
                fetchedAt: compliance.policySnapshot.fetchedAt,
                convertedAmount: compliance.policySnapshot.convertedAmount,
                referenceCurrency: compliance.policySnapshot.referenceCurrency,
              },
            } : {}),
            ...sep38Metadata,
            ...memoMetadata,
          },
        },
      });
    } catch (error) {
      if (error?.code === 'P2002' && idempotencyKey) {
        const existing = await tx.transaction.findUnique({ where: { idempotencyKey } });
        if (existing) {
          const existingQuote = existing.quoteId ? await tx.quote.findUnique({ where: { id: existing.quoteId } }) : null;
          return { quote: existingQuote, transaction: existing, created: false };
        }
      }
      throw error;
    }

    await redeemVoucher({ db: tx, transaction, loyalty: quote.metadata?.loyalty });
    return { quote, transaction, created: true };
  };

  const { quote, transaction, created } = await (prisma.$transaction ? prisma.$transaction(runCore) : runCore(prisma));

  if (!created || transaction.status !== 'processing') {
    return {
      transaction: withIdAlias(transaction),
      quote,
      receipt: transaction.status === 'success' ? buildReceipt({ transaction }) : null,
    };
  }

  let activeTransaction = transaction;
  let submitted = false;
  const trackEnvelope = pathPayment || transaction.metadata?.loyalty?.voucherId || hasLoyaltyReward(transaction);

  try {
    const wallet = await walletService.createOrGetWallet({ user: senderUser });
    const result = await walletService.submitPayment({
      wallet,
      destination,
      amount: normalizedAmount,
      asset: effectiveAsset,
      memo,
      memoType,
      ...(pathPayment ? { pathPayment } : {}),
      ...(trackEnvelope ? {
        onEnvelope: async (txHash) => {
          await prisma.transaction.update({ where: { id: activeTransaction.id }, data: { txHash } });
        },
      } : {}),
    });
    submitted = true;

    activeTransaction = await transitionPaymentState({
      db: prisma,
      transactionId: activeTransaction.id,
      fromState: 'processing',
      toState: 'pending',
      actor: { type: 'user', id: String(senderUser.id) },
      action: 'payment.submitted',
      reason: 'Payment submitted to Stellar network',
      extraData: {
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
      },
    });

    if (!pathPayment) await ledger.postPaymentSettled({ tx: prisma, transaction: activeTransaction });

    await appendEvent({
      eventType: EVENT_TYPES.PAYMENT_SUBMITTED,
      aggregateType: 'Transaction',
      aggregateId: String(activeTransaction.id),
      actorType: 'user',
      actorId: String(senderUser.id),
      payload: {
        rail,
        asset: effectiveAsset,
        amount: normalizedAmount,
        status: activeTransaction.status,
        txHash: activeTransaction.txHash,
        routeType: effectiveRouteType,
        destinationCountry,
        ...memoMetadata,
      },
    }).catch(() => {});

    return {
      transaction: withIdAlias(activeTransaction),
      quote,
      receipt: null,
      ...(result.ledgerConfirmed ? { ledgerConfirmed: true } : {}),
    };
  } catch (error) {
    if (submitted && trackEnvelope) throw error;
    await markTransactionFailed({
      prisma,
      transactionId: activeTransaction.id,
      metadata: activeTransaction.metadata,
      error,
    });
    await runDbTransaction(async (tx) => {
      const failed = await tx.transaction.findUnique({ where: { id: activeTransaction.id } });
      if (failed) await ledger.postPaymentFailed({ tx, transaction: failed });
    }).catch(() => {});
    // Only after the row is 'failed' and the reservation reversal has been
    // attempted: the reversal job relies on both (see refundEngine).
    await handleStellarPaymentFailure({ transaction: activeTransaction, error }).catch(() => {});
    throw error;
  }
};

const executeRefund = async ({ transactionId, reason, amount, adminId }) => {
  const { decrypt } = require('../services/crypto.service');

  if (!ELIGIBLE_REASONS.includes(reason)) {
    throw new Error(`Invalid refund reason. Must be one of: ${ELIGIBLE_REASONS.join(', ')}`);
  }

  const originalTx = await prisma.transaction.findUnique({ where: { id: transactionId }, include: { user: true } });

  if (!originalTx) throw new Error('Original transaction not found.');
  if (originalTx.status !== 'success') throw new Error('Only successful transactions can be refunded.');
  if (originalTx.type !== 'send') throw new Error('Only payments of type "send" can be refunded.');
  if (originalTx.metadata?.pathPayment) throw new Error('Path payments require a separate refund settlement.');

  const refundAmount = amount ? assertValidAmount(amount, originalTx.asset) : originalTx.amount;

  const allRefunds = await prisma.transaction.findMany({ where: { type: 'refund', status: 'success' } });
  const metaRefundsSum = (originalTx.metadata?.refunds || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const dbRefundsSum = allRefunds.filter((tx) => tx.metadata && tx.metadata.originalTransactionId === originalTx.id).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const alreadyRefunded = Math.max(metaRefundsSum, dbRefundsSum);

  const maxRefundable = Number(originalTx.amount) - alreadyRefunded;
  if (Number(refundAmount) > maxRefundable) {
    throw new Error(`Refund amount exceeds the maximum refundable amount of ${maxRefundable} ${originalTx.asset}. Already refunded: ${alreadyRefunded}`);
  }

  const senderWallet = await prisma.wallet.findUnique({
    where: { userId_chain_network: { userId: originalTx.userId, chain: RAIL, network: config.stellar.network } },
  });
  if (!senderWallet) throw new Error('Sender wallet not found. Cannot return funds.');

  let recipientWallet;
  if (originalTx.recipientPhoneNumber) {
    const recipientUser = await prisma.user.findFirst({ where: { phoneNumber: originalTx.recipientPhoneNumber } });
    if (recipientUser) {
      recipientWallet = await prisma.wallet.findUnique({
        where: { userId_chain_network: { userId: recipientUser.id, chain: RAIL, network: config.stellar.network } },
      });
      if (!recipientWallet) {
        recipientWallet = await prisma.wallet.findFirst({ where: { userId: recipientUser.id, network: config.stellar.network } });
      }
    }
  }
  if (!recipientWallet && originalTx.destination) {
    recipientWallet = await prisma.wallet.findFirst({ where: { publicKey: originalTx.destination, network: config.stellar.network } });
  }
  if (!recipientWallet) {
    throw new Error('Recipient wallet is not managed on this platform. Reversals from external addresses are impossible.');
  }

  const secretKey = decrypt(recipientWallet.encryptedSecretKey);
  const refundTx = await prisma.transaction.create({
    data: {
      userId: originalTx.userId,
      type: 'refund',
      amount: String(refundAmount),
      asset: originalTx.asset,
      destination: senderWallet.publicKey,
      rail: RAIL,
      status: 'processing',
      metadata: {
        originalTransactionId: originalTx.id,
        refundReason: reason,
        adminId,
        initiatedAt: new Date().toISOString(),
        stateHistory: [{
          from: null,
          to: 'processing',
          actor: { type: 'administrator', id: String(adminId) },
          timestamp: new Date().toISOString(),
          reason: 'Refund initiated',
        }],
      },
    },
  });

  try {
    const submission = await stellarAdapter.submitPayment({
      secretKey,
      destination: senderWallet.publicKey,
      amount: String(refundAmount),
      asset: originalTx.asset,
      memo: originalTx.id.slice(0, 20),
      memoType: 'text',
    });

    const updatedRefund = await runDbTransaction(async (tx) => {
      const updated = await transitionPaymentState({
        db: tx,
        transactionId: refundTx.id,
        fromState: 'processing',
        toState: 'success',
        actor: { type: 'administrator', id: String(adminId) },
        reason: `Refund settled: ${reason}`,
        extraData: {
          txHash: submission.txHash,
          explorerUrl: submission.explorerUrl,
        },
        metadata: { settledAt: new Date().toISOString() },
      });

      const originalMeta = typeof originalTx.metadata === 'object' && originalTx.metadata !== null ? originalTx.metadata : {};
      const currentRefunds = originalMeta.refunds || [];
      await tx.transaction.update({
        where: { id: originalTx.id },
        data: {
          metadata: {
            ...originalMeta,
            refunds: [
              ...currentRefunds,
              { refundTransactionId: updated.id, amount: String(refundAmount), reason, adminId, timestamp: new Date().toISOString() },
            ],
          },
        },
      });

      await ledger.postRefundSettled({ tx, transaction: updated, originalTransactionId: originalTx.id });
      return updated;
    });

    await writeAuditLog({
      actorType: 'administrator',
      actorId: adminId,
      action: 'admin.transaction.refunded',
      entityType: 'Transaction',
      entityId: String(originalTx.id),
      metadata: { refundTransactionId: updatedRefund.id, amount: String(refundAmount), reason },
    });

    await appendEvent({
      eventType: EVENT_TYPES.PAYMENT_REFUND_SETTLED,
      aggregateType: 'Transaction',
      aggregateId: String(originalTx.id),
      actorType: 'administrator',
      actorId: adminId,
      payload: {
        refundTransactionId: updatedRefund.id,
        amount: String(refundAmount),
        asset: originalTx.asset,
        reason,
      },
    }).catch(() => {});

    return { amount: String(refundAmount), ...updatedRefund };
  } catch (error) {
    await transitionPaymentState({
      db: prisma,
      transactionId: refundTx.id,
      fromState: 'processing',
      toState: 'failed',
      actor: { type: 'administrator', id: String(adminId) },
      reason: error.message,
      metadata: { failedAt: new Date().toISOString(), error: error.message },
    }).catch(() => {});
    throw error;
  }
};

module.exports = {
  executePayment,
  calculateFee,
  buildReceipt,
  executeRefund,
};

