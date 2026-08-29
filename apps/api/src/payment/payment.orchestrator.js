const walletService = require('../wallet/wallet.service');
const stellarAdapter = require('../wallet/stellar.adapter');
const { createQuote, validateQuoteForExecution, QUOTE_STATUS } = require('../pricing/pricing.service');
const { writeAuditLog } = require('../common/audit.service');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { markTransactionFailed } = require('./markFailed');
const ledger = require('./ledger.service');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');
const { assertValidAmount, percentage } = require('../utils/money');

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
    amount: transaction.amount,
    asset: transaction.asset,
    rail: transaction.rail,
    receiptUrl: transaction.explorerUrl,
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
  sourceCountry = 'NG',
  destinationCountry = 'NG',
  routeType,
  quoteId,
  idempotencyKey,
  memo,
  memoType = 'text',
}) => {
  const senderUser = sender;
  if (!senderUser) throw new Error('Sender not found.');

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

  const memoMetadata = (memo !== undefined && memo !== null && memo !== '')
    ? { memo: stellarAdapter.redactMemo ? stellarAdapter.redactMemo(memo) : String(memo), memoType: String(memoType || 'text').toLowerCase() }
    : {};

  // Core runs inside a single Prisma transaction so the quote and the payment
  // reservation commit together (or not at all). `tx` is the active transaction
  // client and must be threaded into every write — especially createQuote — so a
  // rollback cannot strand an orphan quote.
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
        const priorQuote = prior.quoteId ? await tx.quote.findUnique({ where: { id: prior.quoteId } }) : null;
        return { compliance, quote: priorQuote, transaction: prior };
      }
    }

    let quote;
    if (quoteId) {
      const existing = await tx.quote.findUnique({ where: { id: quoteId } });
      await validateQuoteForExecution({ quote: existing, userId: senderUser.id, asset: effectiveAsset, amount: normalizedAmount });
      // Safe to settle: claim the quote so a retry with the same id is rejected.
      quote = await tx.quote.update({ where: { id: quoteId }, data: { status: QUOTE_STATUS.CONSUMED } });
    } else {
      quote = await createQuote({
        userId: senderUser.id,
        sourceCurrency: effectiveAsset,
        targetCurrency: effectiveAsset,
        sourceAmount: normalizedAmount,
        route: rail,
        provider: rail,
        idempotencyKey,
        tx,
      });
    }

    let transaction;
    try {
      transaction = await tx.transaction.create({
        data: {
          userId: senderUser.id,
          type: 'send',
          amount: normalizedAmount,
          asset: effectiveAsset,
          recipientPhoneNumber,
          destination,
          rail,
          routeType: effectiveRouteType,
          quoteId: quote.id,
          idempotencyKey,
          status: 'processing',
          metadata: {
            fee: calculateFee(normalizedAmount, effectiveAsset),
            userHiddenRail: true,
            riskScore: compliance.riskScore,
            ...memoMetadata,
          },
        },
      });
    } catch (error) {
      // A concurrent retry may have already reserved the transaction row by
      // the time we insert. Treat the unique violation as "already created"
      // and return the existing reservation instead of erroring.
      if (error?.code === 'P2002' && idempotencyKey) {
        const existing = await tx.transaction.findUnique({ where: { idempotencyKey } });
        if (existing) {
          const existingQuote = existing.quoteId ? await tx.quote.findUnique({ where: { id: existing.quoteId } }) : null;
          return { compliance, quote: existingQuote, transaction: existing };
        }
      }
      throw error;
    }

    return { compliance, quote, transaction };
  };

  const { quote, transaction } = await (prisma.$transaction ? prisma.$transaction(runCore) : runCore(prisma));

  // A previously reserved transaction that already settled or is in-flight:
  // return it as-is without re-submitting (prevents double-spend on retries).
  // Receipt is only attached when the transaction has reached ledger-backed
  // finality ('success'); pending/processing states get receipt: null.
  if (transaction.status !== 'processing') {
    return {
      transaction: withIdAlias(transaction),
      quote,
      receipt: transaction.status === 'success' ? buildReceipt({ transaction }) : null,
    };
  }

  let activeTransaction = transaction;

  try {
    const wallet = await walletService.createOrGetWallet({ user: senderUser });
    const result = await walletService.submitPayment({
      wallet,
      destination,
      amount: normalizedAmount,
      asset: effectiveAsset,
      memo,
      memoType,
    });

    // Record txHash and move to 'pending' — NOT 'success'. Finality is
    // confirmed by the reconciler once Horizon reports the hash in a closed
    // ledger (successful=true). Issuing a receipt here would be premature.
    activeTransaction = await prisma.transaction.update({
      where: { id: activeTransaction.id },
      data: {
        status: 'pending',
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
      },
    });

    await ledger.postPaymentSettled({ tx: prisma, transaction: activeTransaction });

    await writeAuditLog({
      actorType: 'user',
      actorId: String(senderUser.id),
      action: 'payment.submitted',
      entityType: 'Transaction',
      entityId: String(activeTransaction.id),
      metadata: { rail, status: activeTransaction.status, ...memoMetadata },
    });

    // Return the pending transaction. Receipt is withheld until the
    // reconciler confirms ledger-backed finality.
    return { transaction: withIdAlias(activeTransaction), quote, receipt: null };
  } catch (error) {
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

  const refundAmount = amount ? assertValidAmount(amount, originalTx.asset) : originalTx.amount;

  const allRefunds = await prisma.transaction.findMany({ where: { type: 'refund', status: 'success' } });
  const metaRefundsSum = (originalTx.metadata?.refunds || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const dbRefundsSum = allRefunds.filter((tx) => tx.metadata && tx.metadata.originalTransactionId === originalTx.id).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const alreadyRefunded = Math.max(metaRefundsSum, dbRefundsSum);

  const maxRefundable = Number(originalTx.amount) - alreadyRefunded;
  if (Number(refundAmount) > maxRefundable) {
    throw new Error(`Refund amount exceeds the maximum refundable amount of ${maxRefundable} ${originalTx.asset}. Already refunded: ${alreadyRefunded}`);
  }

  const senderWallet = await prisma.wallet.findUnique({ where: { userId_chain: { userId: originalTx.userId, chain: RAIL } } });
  if (!senderWallet) throw new Error('Sender wallet not found. Cannot return funds.');

  let recipientWallet;
  if (originalTx.recipientPhoneNumber) {
    const recipientUser = await prisma.user.findFirst({ where: { phoneNumber: originalTx.recipientPhoneNumber } });
    if (recipientUser) {
      recipientWallet = await prisma.wallet.findUnique({ where: { userId_chain: { userId: recipientUser.id, chain: RAIL } } });
      if (!recipientWallet) {
        recipientWallet = await prisma.wallet.findFirst({ where: { userId: recipientUser.id } });
      }
    }
  }
  if (!recipientWallet && originalTx.destination) {
    recipientWallet = await prisma.wallet.findFirst({ where: { publicKey: originalTx.destination } });
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
      const updated = await tx.transaction.update({
        where: { id: refundTx.id },
        data: {
          status: 'success',
          txHash: submission.txHash,
          explorerUrl: submission.explorerUrl,
          metadata: { ...refundTx.metadata, settledAt: new Date().toISOString() },
        },
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

    return { amount: String(refundAmount), ...updatedRefund };
  } catch (error) {
    await prisma.transaction.update({
      where: { id: refundTx.id },
      data: {
        status: 'failed',
        metadata: {
          ...refundTx.metadata,
          failedAt: new Date().toISOString(),
          error: error.message,
        },
      },
    });
    throw error;
  }
};

module.exports = {
  executePayment,
  calculateFee,
  buildReceipt,
  executeRefund,
};
