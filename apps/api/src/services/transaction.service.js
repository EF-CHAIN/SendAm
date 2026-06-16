const { decrypt } = require('./crypto.service');
const { sendPayment, getTransactionUrl } = require('./stellar.service');
const Transaction = require('../models/Transaction');
const { limits } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Per-user transfer guardrails: a per-transaction cap plus rolling 24h caps on
 * both total amount and number of sends. Throws on violation so executeSend
 * records the blocked attempt as a failed transaction (audit trail) and the
 * caller surfaces the reason. Only successful sends count toward the rolling
 * totals.
 */
const enforceSendLimits = async (userId, amount) => {
  const parsed = Number(amount);

  if (parsed > limits.maxSendAmount) {
    throw new Error(`Amount exceeds the per-transaction limit of ${limits.maxSendAmount} XLM.`);
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await Transaction.find({
    userId,
    type: 'send',
    status: 'success',
    createdAt: { $gte: since },
  }).select('amount');

  if (recent.length >= limits.dailySendCount) {
    throw new Error(`Daily transfer count limit of ${limits.dailySendCount} reached. Try again later.`);
  }

  const sentToday = recent.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  if (sentToday + parsed > limits.dailySendAmount) {
    const remaining = Math.max(0, limits.dailySendAmount - sentToday);
    throw new Error(`This transfer exceeds your daily limit of ${limits.dailySendAmount} XLM (${remaining.toFixed(2)} XLM remaining today).`);
  }
};

/**
 * The single money-movement pipeline shared by every surface (REST API and
 * the WhatsApp bot). It owns the side effects of a transfer: decrypt the
 * sender's key, submit on-ledger, and record the outcome as a Transaction.
 *
 * Both success and failure are persisted so the admin ledger stays complete.
 * The result is returned (never thrown) so callers can shape their own reply
 * without duplicating this logic — this is the seam future flows (offramp,
 * onramp, swap) extend rather than copy.
 */
const executeSend = async ({ user, wallet, destination, amount, asset = 'XLM' }) => {
  try {
    await enforceSendLimits(user._id, amount);

    const secretKey = decrypt(wallet.encryptedSecretKey);
    const txResponse = await sendPayment({ secretKey, destination, amount, asset });
    const explorerUrl = getTransactionUrl(txResponse.hash);

    const transaction = await Transaction.create({
      userId: user._id,
      type: 'send',
      amount,
      asset,
      destination,
      txHash: txResponse.hash,
      explorerUrl,
      status: 'success',
    });

    return { ok: true, txHash: txResponse.hash, explorerUrl, transaction };
  } catch (error) {
    logger.error('Send failed', error.message);

    await Transaction.create({
      userId: user._id,
      type: 'send',
      amount: amount || '0',
      asset,
      destination: destination || 'unknown',
      status: 'failed',
    });

    return { ok: false, error };
  }
};

module.exports = {
  executeSend,
};
