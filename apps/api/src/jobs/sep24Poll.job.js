'use strict';

const crypto = require('node:crypto');
const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { increment, setGauge } = require('../observability/metrics');
const { outboundHeaders } = require('../observability/context');

const getDefaultPrisma = () => {
  try {
    return require('../common/prisma');
  } catch (_err) {
    return null;
  }
};

const getDefaultNotify = () => require('../services/whatsapp.service').sendTextMessage;

const getDefaultAuditLogger = () => {
  try {
    return require('../common/audit.service').writeAuditLog;
  } catch (_err) {
    return null;
  }
};

const getDefaultEventAppender = () => {
  try {
    return require('../common/event.service').appendEvent;
  } catch (_err) {
    return null;
  }
};

const SEP24_ACTIVE_STATUSES = Object.freeze([
  'incomplete',
  'pending_user_transfer_start',
  'pending_user_transfer_complete',
  'pending_external',
  'pending_anchor',
  'pending_stellar',
  'pending_trust',
  'pending_user',
]);

const SEP24_TERMINAL_STATUSES = Object.freeze([
  'completed',
  'refunded',
  'expired',
  'error',
  'no_market',
  'too_small',
  'too_large',
]);

const SEP24_STATUSES = Object.freeze([
  ...SEP24_ACTIVE_STATUSES,
  ...SEP24_TERMINAL_STATUSES,
]);

const SEP24_TO_INTERNAL_STATUS = Object.freeze({
  incomplete: 'pending',
  pending_user_transfer_start: 'pending',
  pending_user_transfer_complete: 'processing',
  pending_external: 'processing',
  pending_anchor: 'processing',
  pending_stellar: 'processing',
  pending_trust: 'pending',
  pending_user: 'pending',
  completed: 'success',
  refunded: 'reversed',
  expired: 'expired',
  error: 'failed',
  no_market: 'failed',
  too_small: 'failed',
  too_large: 'failed',
});

const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_BATCH_SIZE = 50;

const isTerminalSep24Status = (status) =>
  SEP24_TERMINAL_STATUSES.includes(String(status || '').trim().toLowerCase());

const isKnownSep24Status = (status) =>
  SEP24_STATUSES.includes(String(status || '').trim().toLowerCase());

const formatSep24StatusMessage = ({
  anchorStatus,
  kind = 'deposit',
  amount,
  assetCode = 'USDC',
  anchorTransactionId,
  message,
  moreInfoUrl,
  stellarTransactionId,
} = {}) => {
  const status = String(anchorStatus || '').trim().toLowerCase();
  if (!status || status === 'incomplete') return null;

  const actionLabel = String(kind).toLowerCase().includes('withdraw') ? 'withdrawal' : 'deposit';
  const amountText = amount ? `${amount} ${assetCode}` : assetCode;
  const refText = anchorTransactionId ? ` (Ref: ${anchorTransactionId})` : '';
  const detailText = message ? `: ${message}` : '';
  const linkText = moreInfoUrl ? ` Details: ${moreInfoUrl}` : '';

  switch (status) {
    case 'pending_user_transfer_start':
      return `Action needed: please send your ${amountText} to complete your ${actionLabel}${refText}.${linkText}`;
    case 'pending_user_transfer_complete':
      return `Transfer received: your ${amountText} ${actionLabel} is now being processed${refText}.`;
    case 'pending_trust':
      return `Action needed: please establish a trustline for ${assetCode} to receive your ${amountText} ${actionLabel}${refText}.`;
    case 'pending_user':
      return `Action required: our partner needs additional confirmation for your ${amountText} ${actionLabel}${refText}.${detailText}${linkText}`;
    case 'pending_external':
      return `Update: your ${amountText} ${actionLabel} is awaiting external payment rail confirmation${refText}.`;
    case 'pending_anchor':
      return `Update: your ${amountText} ${actionLabel} is being processed by our anchor partner${refText}.`;
    case 'pending_stellar':
      return `Update: your ${amountText} ${actionLabel} is settling on the Stellar network${refText}.`;
    case 'completed':
      return `Your ${amountText} ${actionLabel} has been completed${refText}.${
        stellarTransactionId ? ` Stellar tx: ${stellarTransactionId}.` : ''
      }`;
    case 'refunded':
      return `Your ${amountText} ${actionLabel} has been refunded${refText}${detailText}.`;
    case 'expired':
      return `Your ${amountText} ${actionLabel} session has expired${refText}. Please start a new request when ready.`;
    case 'error':
      return `Your ${amountText} ${actionLabel} failed${refText}${detailText}. Please contact support if funds were debited.`;
    case 'no_market':
      return `Your ${amountText} ${actionLabel} could not be completed because the market is currently unavailable${refText}.`;
    case 'too_small':
      return `Your ${amountText} ${actionLabel} failed because the amount is below the minimum limit${refText}.`;
    case 'too_large':
      return `Your ${amountText} ${actionLabel} failed because the amount exceeds the maximum limit${refText}.`;
    default:
      return null;
  }
};

const fetchAnchorTransaction = async ({
  transferServerUrl,
  anchorTransactionId,
  jwt = null,
  lang = null,
  axiosImpl = axios,
  timeoutMs = Number(config?.requestLimits?.upstreamTimeoutMs ?? 10000),
} = {}) => {
  const baseUrl = String(transferServerUrl || config?.stellar?.sep24Url || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('SEP-24 transferServerUrl is required to poll transaction status');
  }
  if (!anchorTransactionId) {
    throw new Error('anchorTransactionId is required to poll SEP-24 transaction status');
  }

  const token = jwt ? String(jwt).trim().replace(/^Bearer\s+/i, '') : '';
  const headers = {
    ...outboundHeaders(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const response = await axiosImpl.get(`${baseUrl}/transaction`, {
    params: {
      id: String(anchorTransactionId),
      ...(lang ? { lang } : {}),
    },
    headers,
    timeout: timeoutMs,
  });

  const payload = response.data?.transaction || response.data;
  if (!payload || !payload.id || !payload.status) {
    throw new Error(`Malformed SEP-24 /transaction response for anchor transaction ${anchorTransactionId}`);
  }
  return payload;
};

const applySep24StatusUpdate = async ({
  transaction,
  anchorTransaction,
  source = 'poll',
  prismaClient = getDefaultPrisma(),
  notify = getDefaultNotify(),
  writeAuditLog = getDefaultAuditLogger(),
  appendEvent = getDefaultEventAppender(),
} = {}) => {
  if (!transaction) {
    throw new Error('transaction is required to apply SEP-24 status update');
  }

  const nextAnchorStatus = String(anchorTransaction?.status || '').trim().toLowerCase();
  if (!isKnownSep24Status(nextAnchorStatus)) {
    throw new Error(`Unknown SEP-24 status: ${anchorTransaction?.status}`);
  }

  const existingMeta = transaction.metadata && typeof transaction.metadata === 'object'
    ? transaction.metadata
    : {};
  const existingSep24 = existingMeta.sep24 && typeof existingMeta.sep24 === 'object'
    ? existingMeta.sep24
    : {};

  const anchorTransactionId = String(
    anchorTransaction?.id
      || existingSep24.anchorTransactionId
      || transaction.providerTransactionId
      || '',
  ).trim();

  const currentAnchorStatus = existingSep24.anchorStatus
    ? String(existingSep24.anchorStatus).trim().toLowerCase()
    : null;

  if (currentAnchorStatus && isTerminalSep24Status(currentAnchorStatus)) {
    return {
      updated: false,
      duplicate: currentAnchorStatus === nextAnchorStatus,
      ignoredTerminal: currentAnchorStatus !== nextAnchorStatus,
      transactionId: transaction.id,
      anchorTransactionId,
      anchorStatus: currentAnchorStatus,
      internalStatus: transaction.status,
      notified: false,
    };
  }

  if (currentAnchorStatus === nextAnchorStatus) {
    return {
      updated: false,
      duplicate: true,
      ignoredTerminal: false,
      transactionId: transaction.id,
      anchorTransactionId,
      anchorStatus: nextAnchorStatus,
      internalStatus: transaction.status,
      notified: false,
    };
  }

  const internalStatus = SEP24_TO_INTERNAL_STATUS[nextAnchorStatus];
  const nowIso = new Date().toISOString();
  const stellarTransactionId = anchorTransaction?.stellar_transaction_id
    || anchorTransaction?.stellar_tx_id
    || existingSep24.stellarTransactionId
    || null;
  const externalTransactionId = anchorTransaction?.external_transaction_id
    || existingSep24.externalTransactionId
    || null;
  const amountIn = anchorTransaction?.amount_in != null
    ? String(anchorTransaction.amount_in)
    : (existingSep24.amountIn || null);
  const amountOut = anchorTransaction?.amount_out != null
    ? String(anchorTransaction.amount_out)
    : (existingSep24.amountOut || null);
  const amountFee = anchorTransaction?.amount_fee != null
    ? String(anchorTransaction.amount_fee)
    : (existingSep24.amountFee || null);
  const kind = anchorTransaction?.kind || existingSep24.kind || transaction.type || 'deposit';
  const assetCode = existingSep24.assetCode || anchorTransaction?.asset_code || transaction.asset || 'USDC';
  const moreInfoUrl = anchorTransaction?.more_info_url || existingSep24.moreInfoUrl || null;
  const anchorMessage = anchorTransaction?.message || null;

  const existingHistory = Array.isArray(existingSep24.statusHistory) ? existingSep24.statusHistory : [];
  const nextHistory = [
    ...existingHistory,
    {
      from: currentAnchorStatus,
      to: nextAnchorStatus,
      source,
      timestamp: nowIso,
      ...(anchorMessage ? { message: anchorMessage } : {}),
    },
  ];

  const notifiedStatuses = Array.isArray(existingSep24.notifiedStatuses)
    ? [...existingSep24.notifiedStatuses]
    : [];

  let updatedSep24Meta = {
    ...existingSep24,
    anchorTransactionId,
    anchorStatus: nextAnchorStatus,
    previousAnchorStatus: currentAnchorStatus,
    kind,
    assetCode,
    amountIn,
    amountOut,
    amountFee,
    externalTransactionId,
    stellarTransactionId,
    moreInfoUrl,
    message: anchorMessage,
    startedAt: anchorTransaction?.started_at || existingSep24.startedAt || null,
    completedAt: anchorTransaction?.completed_at || existingSep24.completedAt || null,
    lastSource: source,
    updatedAt: nowIso,
    statusHistory: nextHistory,
    notifiedStatuses,
  };

  let updatedTransaction = transaction;
  if (prismaClient?.transaction?.update) {
    const resolvedAmount = amountIn && (!transaction.amount || transaction.amount === '0')
      ? amountIn
      : undefined;

    updatedTransaction = await prismaClient.transaction.update({
      where: { id: transaction.id },
      data: {
        status: internalStatus,
        ...(stellarTransactionId ? { txHash: String(stellarTransactionId) } : {}),
        ...(resolvedAmount ? { amount: resolvedAmount } : {}),
        metadata: {
          ...existingMeta,
          sep24: updatedSep24Meta,
        },
      },
    });
  }

  increment('sendam_sep24_status_transitions_total', {
    from: currentAnchorStatus || 'none',
    to: nextAnchorStatus,
    source,
  });

  if (typeof writeAuditLog === 'function') {
    await writeAuditLog({
      actorType: 'system',
      actorId: source === 'webhook' ? 'sep24_webhook' : 'sep24_poller',
      action: 'sep24.status.transitioned',
      entityType: 'Transaction',
      entityId: String(transaction.id),
      metadata: {
        anchorTransactionId,
        fromAnchorStatus: currentAnchorStatus,
        toAnchorStatus: nextAnchorStatus,
        internalStatus,
        source,
      },
    }).catch((err) => logger.warn('sep24_audit_log_failed', { message: err.message }));
  }

  if (typeof appendEvent === 'function') {
    await appendEvent({
      eventType: 'sep24.status.updated',
      aggregateType: 'Transaction',
      aggregateId: String(transaction.id),
      actorType: 'system',
      actorId: source === 'webhook' ? 'sep24_webhook' : 'sep24_poller',
      payload: {
        anchorTransactionId,
        from: currentAnchorStatus,
        to: nextAnchorStatus,
        internalStatus,
        source,
      },
    }).catch(() => {});
  }

  const phoneNumber = transaction.user?.phoneNumber
    || transaction.recipientPhoneNumber
    || existingSep24.phoneNumber
    || anchorTransaction?.phone_number
    || null;

  const notificationText = formatSep24StatusMessage({
    anchorStatus: nextAnchorStatus,
    kind,
    amount: amountOut || amountIn || (transaction.amount && transaction.amount !== '0' ? transaction.amount : null),
    assetCode,
    anchorTransactionId,
    message: anchorMessage,
    moreInfoUrl,
    stellarTransactionId,
  });

  let notified = false;
  if (
    phoneNumber
    && notificationText
    && typeof notify === 'function'
    && !notifiedStatuses.includes(nextAnchorStatus)
  ) {
    try {
      const sendResult = await notify(phoneNumber, notificationText, {
        ...(prismaClient?.notification?.create ? { prisma: prismaClient } : {}),
        notification: {
          userId: transaction.userId || null,
          type: isTerminalSep24Status(nextAnchorStatus) ? 'sep24_terminal_update' : 'sep24_progress_update',
          referenceType: 'transaction',
          referenceId: transaction.id,
        },
      });

      const failedOutcome = sendResult === null
        || sendResult?.outcome === 'permanent_failure'
        || sendResult?.outcome === 'unknown';

      if (failedOutcome) {
        increment('sendam_sep24_notifications_total', { status: nextAnchorStatus, result: 'failed' });
        logger.warn('sep24_notification_failed', {
          transactionId: transaction.id,
          anchorTransactionId,
          status: nextAnchorStatus,
          outcome: sendResult?.outcome || 'transient_failure',
        });
      } else {
        notified = true;
        notifiedStatuses.push(nextAnchorStatus);
        updatedSep24Meta = {
          ...updatedSep24Meta,
          notifiedStatuses,
        };
        if (prismaClient?.transaction?.update) {
          await prismaClient.transaction.update({
            where: { id: transaction.id },
            data: {
              metadata: {
                ...(updatedTransaction?.metadata || existingMeta),
                sep24: updatedSep24Meta,
              },
            },
          });
        }
        increment('sendam_sep24_notifications_total', { status: nextAnchorStatus, result: 'sent' });
      }
    } catch (err) {
      increment('sendam_sep24_notifications_total', { status: nextAnchorStatus, result: 'failed' });
      logger.warn('sep24_notification_error', {
        transactionId: transaction.id,
        anchorTransactionId,
        status: nextAnchorStatus,
        message: err.message,
      });
      if (prismaClient?.transaction?.update) {
        await prismaClient.transaction.update({
          where: { id: transaction.id },
          data: {
            metadata: {
              ...(updatedTransaction?.metadata || existingMeta),
              sep24: {
                ...updatedSep24Meta,
                lastNotificationError: err.message,
              },
            },
          },
        }).catch(() => {});
      }
    }
  }

  return {
    updated: true,
    duplicate: false,
    ignoredTerminal: false,
    transactionId: transaction.id,
    anchorTransactionId,
    previousAnchorStatus: currentAnchorStatus,
    anchorStatus: nextAnchorStatus,
    internalStatus,
    terminal: isTerminalSep24Status(nextAnchorStatus),
    notified,
  };
};

const pollSep24Transaction = async (transaction, deps = {}) => {
  const sep24Meta = transaction?.metadata?.sep24 || {};
  const anchorTransactionId = transaction?.providerTransactionId || sep24Meta.anchorTransactionId;
  if (!anchorTransactionId) {
    throw new Error(`Transaction ${transaction?.id} is missing SEP-24 anchorTransactionId`);
  }

  const transferServerUrl = sep24Meta.transferServerUrl
    || deps.transferServerUrl
    || config?.stellar?.sep24Url;

  let jwt = sep24Meta.jwt || deps.jwt || null;
  if (!jwt && typeof deps.resolveJwt === 'function') {
    jwt = await deps.resolveJwt(transaction);
  }

  const anchorTransaction = await fetchAnchorTransaction({
    transferServerUrl,
    anchorTransactionId,
    jwt,
    axiosImpl: deps.axiosImpl || axios,
    timeoutMs: deps.timeoutMs,
  });

  return applySep24StatusUpdate({
    transaction,
    anchorTransaction,
    source: 'poll',
    prismaClient: deps.prismaClient,
    notify: deps.notify,
    writeAuditLog: deps.writeAuditLog,
    appendEvent: deps.appendEvent,
  });
};

const runSep24PollSweep = async (deps = {}) => {
  const prismaClient = deps.prismaClient || getDefaultPrisma();
  if (!prismaClient?.transaction?.findMany) {
    return { ok: true, polled: 0, updated: 0, terminal: 0, unchanged: 0, errors: 0 };
  }

  const batchSize = Number(deps.batchSize || DEFAULT_BATCH_SIZE);
  let activeTransactions;
  try {
    activeTransactions = await prismaClient.transaction.findMany({
      where: {
        rail: 'sep24',
        status: { in: ['pending', 'processing'] },
      },
      include: {
        user: { select: { id: true, phoneNumber: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: batchSize,
    });
  } catch (err) {
    logger.error('sep24_poller_load_failed', { message: err.message });
    return { ok: false, polled: 0, updated: 0, terminal: 0, unchanged: 0, errors: 1 };
  }

  let polled = 0;
  let updated = 0;
  let terminal = 0;
  let unchanged = 0;
  let errors = 0;

  for (const tx of activeTransactions) {
    polled += 1;
    try {
      const outcome = await pollSep24Transaction(tx, { ...deps, prismaClient });
      if (outcome.updated) {
        updated += 1;
        if (outcome.terminal) terminal += 1;
      } else {
        unchanged += 1;
      }
    } catch (err) {
      errors += 1;
      logger.error('sep24_poll_transaction_failed', {
        transactionId: tx?.id,
        anchorTransactionId: tx?.providerTransactionId || tx?.metadata?.sep24?.anchorTransactionId,
        message: err.message,
      });
    }
  }

  return { ok: true, polled, updated, terminal, unchanged, errors };
};

const startSep24Poller = ({
  intervalMs = Number(config?.stellar?.sep24PollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  prismaClient = getDefaultPrisma(),
  notify = getDefaultNotify(),
  axiosImpl = axios,
  resolveJwt = null,
  transferServerUrl = null,
  jwt = null,
  batchSize = DEFAULT_BATCH_SIZE,
  runImmediately = true,
} = {}) => {
  const deps = {
    prismaClient,
    notify,
    axiosImpl,
    resolveJwt,
    transferServerUrl,
    jwt,
    batchSize,
  };

  let lastSuccessfulSweepAt = 0;
  let inFlight = false;

  setGauge('sendam_sep24_poll_sweep_last_success_timestamp_seconds', () => lastSuccessfulSweepAt / 1000);
  setGauge('sendam_sep24_poll_sweep_age_seconds', () => (
    lastSuccessfulSweepAt ? Math.max(0, (Date.now() - lastSuccessfulSweepAt) / 1000) : -1
  ));

  const runOnce = async () => {
    if (inFlight) {
      return { ok: true, skipped: true, reason: 'sweep_in_flight' };
    }
    inFlight = true;
    try {
      const result = await runSep24PollSweep(deps);
      if (result.ok) {
        lastSuccessfulSweepAt = Date.now();
      }
      return result;
    } finally {
      inFlight = false;
    }
  };

  logger.info('sep24_poller_started', { intervalMs });

  if (runImmediately) {
    runOnce().catch((err) => {
      logger.error('sep24_poller_initial_sweep_failed', { message: err.message });
    });
  }

  const timer = setInterval(() => {
    runOnce().catch((err) => {
      logger.error('sep24_poller_sweep_failed', { message: err.message });
    });
  }, intervalMs);

  if (timer.unref) timer.unref();

  const stop = () => {
    clearInterval(timer);
    logger.info('sep24_poller_stopped');
  };

  return { stop, runOnce };
};

const verifyAnchorWebhookSignature = ({ rawBody, signature, secret } = {}) => {
  if (!secret || !signature || rawBody == null) return false;

  const rawText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const receivedHex = String(signature).trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-fA-F]+$/.test(receivedHex)) return false;

  const expectedHex = crypto
    .createHmac('sha256', String(secret))
    .update(rawText)
    .digest('hex');

  const receivedBuf = Buffer.from(receivedHex.toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'utf8');
  if (receivedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(receivedBuf, expectedBuf);
};

const parseWebhookTransactionPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('Invalid SEP-24 webhook payload'), { statusCode: 400 });
  }
  const tx = payload.transaction && typeof payload.transaction === 'object'
    ? payload.transaction
    : payload;

  const anchorTransactionId = String(tx.id || tx.transaction_id || '').trim();
  const status = String(tx.status || '').trim().toLowerCase();

  if (!anchorTransactionId || !status) {
    throw Object.assign(new Error('SEP-24 webhook payload must include transaction id and status'), {
      statusCode: 400,
    });
  }
  if (!isKnownSep24Status(status)) {
    throw Object.assign(new Error(`Unsupported SEP-24 status in webhook payload: ${status}`), {
      statusCode: 400,
    });
  }

  return {
    ...tx,
    id: anchorTransactionId,
    status,
  };
};

const handleSep24WebhookCallback = async (payload, options = {}) => {
  const prismaClient = options.prismaClient || options.prisma || getDefaultPrisma();
  const txPayload = parseWebhookTransactionPayload(payload);

  let dbTransaction = null;
  if (prismaClient?.transaction?.findFirst) {
    dbTransaction = await prismaClient.transaction.findFirst({
      where: { providerTransactionId: txPayload.id },
      include: { user: true },
    });
  }

  if (!dbTransaction && txPayload.external_transaction_id && prismaClient?.transaction?.findUnique) {
    dbTransaction = await prismaClient.transaction.findUnique({
      where: { id: String(txPayload.external_transaction_id) },
      include: { user: true },
    });
  }

  if (!dbTransaction) {
    increment('sendam_sep24_webhooks_total', { status: txPayload.status, result: 'unmatched' });
    logger.info('sep24_webhook_unmatched', {
      anchorTransactionId: txPayload.id,
      status: txPayload.status,
    });
    return {
      processed: true,
      unmatched: true,
      updated: false,
      anchorTransactionId: txPayload.id,
      anchorStatus: txPayload.status,
      notified: false,
    };
  }

  const result = await applySep24StatusUpdate({
    transaction: dbTransaction,
    anchorTransaction: txPayload,
    source: 'webhook',
    prismaClient,
    notify: options.notify || getDefaultNotify(),
    writeAuditLog: options.writeAuditLog || getDefaultAuditLogger(),
    appendEvent: options.appendEvent || getDefaultEventAppender(),
  });

  increment('sendam_sep24_webhooks_total', {
    status: txPayload.status,
    result: result.updated ? 'updated' : 'ignored',
  });

  return {
    processed: true,
    unmatched: false,
    ...result,
  };
};

const createSep24WebhookHandler = (options = {}) => async (req, res, next) => {
  try {
    const secret = options.webhookSecret !== undefined
      ? options.webhookSecret
      : config?.stellar?.anchorWebhookSecret;

    if (secret) {
      const signature = req.get?.('x-sep24-signature')
        || req.get?.('x-anchor-signature')
        || req.get?.('x-hub-signature-256')
        || req.get?.('x-signature')
        || req.headers?.['x-sep24-signature']
        || req.headers?.['x-anchor-signature']
        || req.headers?.['x-hub-signature-256']
        || req.headers?.['x-signature'];

      const rawBody = req.rawBody !== undefined
        ? req.rawBody
        : JSON.stringify(req.body || {});

      if (!verifyAnchorWebhookSignature({ rawBody, signature, secret })) {
        increment('sendam_sep24_webhooks_total', { status: 'unknown', result: 'invalid_signature' });
        return res.status(401).json({
          success: false,
          error: 'Invalid or missing SEP-24 webhook signature',
        });
      }
    }

    const result = await handleSep24WebhookCallback(req.body, options);
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error.statusCode === 400) {
      increment('sendam_sep24_webhooks_total', { status: 'unknown', result: 'malformed' });
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }
    return next(error);
  }
};

module.exports = {
  SEP24_ACTIVE_STATUSES,
  SEP24_TERMINAL_STATUSES,
  SEP24_STATUSES,
  SEP24_TO_INTERNAL_STATUS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
  isTerminalSep24Status,
  isKnownSep24Status,
  formatSep24StatusMessage,
  fetchAnchorTransaction,
  applySep24StatusUpdate,
  pollSep24Transaction,
  runSep24PollSweep,
  startSep24Poller,
  verifyAnchorWebhookSignature,
  parseWebhookTransactionPayload,
  handleSep24WebhookCallback,
  createSep24WebhookHandler,
};
