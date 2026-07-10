const { decrypt } = require('./crypto.service');
const { resolveAdapter } = require('./chains');
const Transaction = require('../models/Transaction');
const { limits } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Per-user transfer guardrails: a per-transaction cap plus rolling 24h caps on
 * both total amount and number of sends. Throws on violation so executeSend
 * records the blocked attempt as a failed transaction (audit trail) and the
 * caller surfaces the reason. Only successful sends count toward the rolling
 * totals.
 *
 * Limits are chain-agnostic for now — XLM and ETH amounts aren't directly
 * comparable without a price oracle, so the same numeric caps apply
 * regardless of which chain a transfer is on. Revisit once one exists.
 */
const enforceSendLimits = async (userId, amount) => {
  const parsed = Number(amount);

  if (parsed > limits.maxSendAmount) {
    throw new Error(`Amount exceeds the per-transaction limit of ${limits.maxSendAmount}.`);
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
    throw new Error(`This transfer exceeds your daily limit of ${limits.dailySendAmount} (${remaining.toFixed(2)} remaining today).`);
  }
};

/**
 * The single money-movement pipeline shared by every surface (REST API and
 * the WhatsApp bot). It owns the side effects of a transfer: decrypt the
 * sender's key, submit on the resolved chain, and record the outcome as a
 * Transaction.
 *
 * Both success and failure are persisted so the admin ledger stays complete.
 * The result is returned (never thrown) so callers can shape their own reply
 * without duplicating this logic — this is the seam future flows (offramp,
 * onramp, swap) extend rather than copy.
 *
 * `chain` is read from `wallet.chain` rather than taken as a separate
 * parameter — the wallet doc is already chain-specific, so there is no
 * second value that could disagree with it.
 */
const executeSend = async ({ user, wallet, destination, amount, asset }) => {
  const chain = wallet.chain;
  try {
    await enforceSendLimits(user._id, amount);

    const secretKey = decrypt(wallet.encryptedSecretKey);
    const { txHash, explorerUrl } = await resolveAdapter(chain).submitPayment({ secretKey, destination, amount, asset });

    const transaction = await Transaction.create({
      userId: user._id,
      chain,
      type: 'send',
      amount,
      asset,
      destination,
      txHash,
      explorerUrl,
      status: 'success',
    });

    return { ok: true, txHash, explorerUrl, transaction };
  } catch (error) {
    logger.error('Send failed', error.message);

    await Transaction.create({
      userId: user._id,
      chain,
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
  enforceSendLimits,
  executeSend,
};
