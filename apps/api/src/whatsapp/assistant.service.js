const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const walletService = require('../wallet/wallet.service');
const { validateAddress } = require('../wallet/stellar.adapter');
const { executePayment } = require('../payment/payment.orchestrator');
const { verifyPin } = require('../compliance/pin.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const { claimPendingSend } = require('./pendingClaim');
const { createRecipientResolver } = require('./recipientResolver');
const defaultPrisma = require('../common/prisma');
const { canonicalizePhoneNumber } = require('../utils/validators');
const { parseConsentCommand, updateUserConsent, isMessageAllowed } = require('../compliance/consent.service');
const { t, SUPPORTED_LOCALES } = require('../i18n/messages');
const { formatDateByLocale, formatAmountByLocale } = require('../i18n/formatters');

const PENDING_SEND_TTL_MS = 10 * 60 * 1000;
const NATIVE_ASSET = 'XLM';

const resolveUser = async (phoneNumber, whatsappName, db = defaultPrisma) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  const now = new Date();
  let user = await db.user.findUnique({ where: { phoneNumber: canonicalPhone } });
  if (!user) {
    user = await db.user.create({
      data: {
        phoneNumber: canonicalPhone,
        whatsappName,
        lastCustomerInteractionAt: now,
      },
    });
  } else {
    const existingPending = user.pendingSend;
    const updateData = { lastCustomerInteractionAt: now };
    if (whatsappName && user.whatsappName !== whatsappName) {
      updateData.whatsappName = whatsappName;
    }
    user = await db.user.update({
      where: { id: user.id },
      data: updateData,
    });
    if (existingPending && !user.pendingSend) {
      user.pendingSend = existingPending;
    }
  }
  return user;
};

const parsePaymentIntent = (text) => {
  const normalized = String(text || '').trim();
  const memoMatch = normalized.match(/(?:\bwith\s+memo\b|\bmemo\b)(?::|\s+)?(?:(text|id|hash|return):)?\s*([^\s]+)/i);
  let memo;
  let memoType;
  let textWithoutMemo = normalized;
  if (memoMatch) {
    memoType = memoMatch[1] ? memoMatch[1].toLowerCase() : 'text';
    memo = memoMatch[2];
    textWithoutMemo = normalized.replace(memoMatch[0], '').trim();
  }

  const sendMatch = textWithoutMemo.match(
    /(?:send|pay|transfer)\s+([\d.]+)\s*((?!to\b)[a-zA-Z]{2,5})?\s+(?:to\s+)?(.+)/i
  );
  if (!sendMatch) return null;
  return {
    amount: sendMatch[1],
    asset: sendMatch[2] ? sendMatch[2].toUpperCase() : NATIVE_ASSET,
    recipient: sendMatch[3].trim(),
    ...(memo ? { memo, memoType } : {}),
  };
};

const requestConfirmation = async ({ phoneNumber, user, intent, notify, db = defaultPrisma }) => {
  const resolveRecipient = createRecipientResolver({ prisma: db, walletService });
  const recipient = await resolveRecipient(user, intent.recipient);
  const locale = user.locale || 'en';

  if (!validateAddress(String(recipient.destination || '').trim())) {
    await notify(
      phoneNumber,
      t('invalid_destination', { label: recipient.label }, locale)
    );
    return;
  }

  const hasFindFirst = Boolean(db.transaction?.findFirst && db.alias?.findFirst);

  const previousTx = db.transaction?.findFirst
    ? await db.transaction.findFirst({
        where: {
          userId: user.id,
          destination: recipient.destination,
          status: 'success',
        },
      }).catch(() => null)
    : (db.transaction?.findMany ? (await db.transaction.findMany({
        where: {
          userId: user.id,
          destination: recipient.destination,
          status: 'success',
        },
      }).catch(() => []))[0] : null);

  const isSavedContact = db.alias?.findFirst
    ? await db.alias.findFirst({
        where: {
          userId: user.id,
          target: recipient.destination,
        },
      }).catch(() => null)
    : (db.alias?.findUnique ? await db.alias.findUnique({
        where: { userId_alias: { userId: user.id, alias: recipient.destination.toLowerCase() } },
      }).catch(() => null) : null);

  const isFirstTime = !previousTx;
  const isHighRisk = hasFindFirst ? (isFirstTime && !isSavedContact) : false;

  const addressStr = String(recipient.destination).trim();
  const fingerprint = `SDA-FP-${crypto.createHash('sha256').update(addressStr).digest('hex').slice(0, 8).toUpperCase()}`;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_SEND_TTL_MS);
  const stateId = `ps_${now.getTime()}_${crypto.randomBytes(4).toString('hex')}`;
  const step = isHighRisk ? 'AWAITING_HIGH_RISK_CONFIRMATION' : 'AWAITING_PIN';

  const pendingSend = {
    version: 1,
    stateId,
    step,
    amount: intent.amount,
    asset: intent.asset,
    destination: recipient.destination,
    alias: recipient.label,
    memo: intent.memo,
    memoType: intent.memoType,
    routeType: 'domestic',
    requestedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    isHighRisk,
    highRiskConfirmed: false,
    fingerprint,
  };

  await db.user.update({
    where: { id: user.id },
    data: { pendingSend },
  });

  if (isHighRisk) {
    const warnMsg = t('high_risk_warning', { fingerprint }, locale);
    await notify(phoneNumber, warnMsg);
  } else {
    const formattedAmount = formatAmountByLocale(intent.amount, intent.asset, locale);
    const memoLine = intent.memo ? `\nMemo (${intent.memoType || 'text'}): ${intent.memo}` : '';
    const confirmMsg = t('payment_confirm', {
      amount: intent.amount,
      asset: intent.asset,
      label: recipient.label,
      memoLine,
    }, locale);
    await notify(phoneNumber, confirmMsg);
  }
};

const handlePendingPin = async ({ phoneNumber, user, text, notify, db = defaultPrisma }) => {
  if (!user.pendingSend?.destination) return false;

  const locale = user.locale || 'en';
  const pendingState = user.pendingSend;
  const lowered = String(text).trim().toLowerCase();

  if (lowered === 'no' || lowered === 'cancel') {
    await db.user.update({ where: { id: user.id }, data: { pendingSend: Prisma.DbNull } });
    await notify(phoneNumber, t('payment_cancelled', {}, locale));
    return true;
  }

  const expireTime = pendingState.expiresAt
    ? new Date(pendingState.expiresAt).getTime()
    : new Date(pendingState.requestedAt).getTime() + PENDING_SEND_TTL_MS;

  if (Date.now() > expireTime) {
    await db.user.update({ where: { id: user.id }, data: { pendingSend: Prisma.DbNull } });
    await notify(phoneNumber, t('payment_expired', {}, locale));
    return true;
  }

  const isHighRiskStep = pendingState.step === 'AWAITING_HIGH_RISK_CONFIRMATION' || (pendingState.isHighRisk && !pendingState.highRiskConfirmed);

  if (isHighRiskStep) {
    if (lowered === 'yes' || lowered === 'oui' || lowered === 'si') {
      const now = new Date();
      const newExpiresAt = new Date(now.getTime() + PENDING_SEND_TTL_MS);
      const updatedPending = {
        ...pendingState,
        step: 'AWAITING_PIN',
        highRiskConfirmed: true,
        requestedAt: now.toISOString(),
        expiresAt: newExpiresAt.toISOString(),
      };
      await db.user.update({
        where: { id: user.id },
        data: { pendingSend: updatedPending },
      });

      const memoLine = updatedPending.memo ? `Memo (${updatedPending.memoType || 'text'}): ${updatedPending.memo}\n` : '';
      const confirmMsg = t('payment_confirm_high_risk', {
        amount: updatedPending.amount,
        asset: updatedPending.asset,
        fingerprint: updatedPending.fingerprint,
        memoLine,
      }, locale);
      await notify(phoneNumber, confirmMsg);
      return true;
    } else {
      await notify(phoneNumber, t('invalid_high_risk_reply', {}, locale));
      return true;
    }
  }

  const userWithPin = await db.user.findUnique({ where: { id: user.id } });
  if (!verifyPin(text, userWithPin.pinHash)) {
    await notify(phoneNumber, t('pin_failed', {}, locale));
    return true;
  }

  const pending = user.pendingSend;
  if (!(await claimPendingSend({ prisma: db, Prisma, userId: user.id }))) {
    await notify(phoneNumber, t('already_processed', {}, locale));
    return true;
  }

  const result = await executePayment({
    sender: user,
    destination: pending.destination,
    amount: pending.amount,
    asset: pending.asset,
    memo: pending.memo,
    memoType: pending.memoType,
    routeType: pending.routeType,
  });

  const receiptMsg = t('payment_success', {
    status: result.transaction.status,
    receiptId: result.receipt.transactionId,
  }, locale);

  await notify(phoneNumber, receiptMsg, {
    notification: {
      userId: user.id,
      type: 'transaction_receipt',
      referenceType: 'transaction',
      referenceId: result.transaction.id,
    },
  });
  return true;
};

const processMessage = async (phoneNumber, whatsappName, text, options = {}) => {
  const notify = typeof options === 'function' ? options : (options.notify || sendTextMessage);
  const db = options.prisma || defaultPrisma;

  const user = await resolveUser(phoneNumber, whatsappName, db);
  const locale = user.locale || 'en';

  const normalized = String(text || '').trim().toLowerCase();

  // Language/locale selection command (#192)
  const langMatch = normalized.match(/^(?:lang|language|locale)\s+([a-z]{2})$/i);
  if (langMatch) {
    const requestedLang = langMatch[1].toLowerCase();
    const newLocale = SUPPORTED_LOCALES.includes(requestedLang) ? requestedLang : 'en';
    const updatedUser = await db.user.update({
      where: { id: user.id },
      data: { locale: newLocale },
    });
    user.locale = updatedUser.locale;
    await notify(phoneNumber, t('lang_updated', { language: newLocale }, newLocale));
    return;
  }

  // Opt-out / Opt-in consent handling (#191)
  const consentCmd = parseConsentCommand(text);
  if (consentCmd.isConsentCommand) {
    const updatedUser = await updateUserConsent({
      userId: user.id,
      phoneNumber,
      consent: consentCmd.consent,
      source: 'whatsapp_keyword',
      prisma: db,
    });
    user.messagingConsent = updatedUser.messagingConsent;
    const msgKey = consentCmd.consent === 'opted_out' ? 'opt_out_success' : 'opt_in_success';
    await notify(phoneNumber, t(msgKey, {}, user.locale));
    return;
  }

  if (await handlePendingPin({ phoneNumber, user, text, notify, db })) return;

  if (['hi', 'hello', 'help', 'menu'].includes(normalized)) {
    if (!isMessageAllowed({ user, isTransactional: false })) {
      await notify(phoneNumber, t('opted_out_blocked', {}, locale));
      return;
    }
    await notify(phoneNumber, t('welcome_help', {}, locale));
    return;
  }

  if (normalized.includes('balance')) {
    await walletService.ensureWalletsForUser({ user });
    const balances = await walletService.balancesForUser({ userId: user.id });
    const lines = balances.flatMap((b) => {
      if (b.error) return [`${b.chain}: unavailable (${b.error})`];
      return (b.assets || []).map((a) => `${a.asset}: ${formatAmountByLocale(a.value, a.asset, locale)}`);
    });
    const headerMsg = t('balances_header', { lines: lines.join('\n') }, locale);
    await notify(phoneNumber, headerMsg);
    return;
  }

  if (normalized.includes('receive')) {
    const wallets = await walletService.ensureWalletsForUser({ user });
    const lines = wallets.map((w) => `${w.chain}: ${w.publicKey}`);
    const headerMsg = t('receive_header', { lines: lines.join('\n') }, locale);
    await notify(phoneNumber, headerMsg);
    return;
  }

  if (normalized.includes('history') || normalized.includes('transactions')) {
    const transactions = db.transaction?.findMany ? await db.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }) : [];
    const lines = transactions.map((tx) => `${tx.type}: ${formatAmountByLocale(tx.amount, tx.asset, locale)} - ${tx.status}`);
    const historyText = lines.length ? lines.join('\n') : t('history_empty', {}, locale);
    await notify(phoneNumber, historyText);
    return;
  }

  const paymentIntent = parsePaymentIntent(text);
  if (paymentIntent) {
    await requestConfirmation({ phoneNumber, user, intent: paymentIntent, notify, db });
    return;
  }

  await notify(phoneNumber, t('fallback_menu', {}, locale));
};

module.exports = {
  processMessage,
  parsePaymentIntent,
};
