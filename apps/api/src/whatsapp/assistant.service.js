const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const walletService = require('../wallet/wallet.service');
const { validateAddress } = require('../wallet/stellar.adapter');
const { executePayment } = require('../payment/payment.orchestrator');
const { verifyPin, verifyPinAttempt } = require('../compliance/pin.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const { claimPendingSend } = require('./pendingClaim');
const { createRecipientResolver } = require('./recipientResolver');
const { createQuote } = require('../pricing/pricing.service');
const defaultPrisma = require('../common/prisma');
const { canonicalizePhoneNumber, isValidPhoneNumber } = require('../utils/validators');
const { parseConsentCommand, applyConsentKeyword, isMessageAllowed } = require('../compliance/consent.service');
const { t, SUPPORTED_LOCALES } = require('../i18n/messages');
const { formatAmountByLocale } = require('../i18n/formatters');
const { handleRecurringMessage } = require('../payment/recurringPayments');
const { buildStandardReceipt, formatChannelReceiptMessage } = require('../services/receipt.service');
const {
  findOpenHandoff,
  handoffUnrecognizedMessage,
  handoffByRequest,
  resetUnrecognizedCount,
} = require('../support/agentHandoff');

const { matchContacts } = require('../services/contactMatcher');
const { sendMetaMessage } = require('../services/whatsappMedia');
const { sendVoiceReceipt } = require('../voice/voiceReceipt');
const { parseRegionalIntent } = require('../voice/intentParser');
const config = require('../config/env');
const logger = require('../utils/logger');

// Hand PDF rendering to the background worker (#1014). Never blocks or fails
// the reply: the text receipt has already been sent.
const queuePdfReceipt = (transactionId) => {
  if (!config.receipts?.bucket) return;
  try {
    const { enqueueReceiptGeneration } = require('../jobs/generateReceipt.job');
    Promise.resolve(enqueueReceiptGeneration(transactionId)).catch((error) => {
      logger.warn('receipt_pdf_enqueue_failed', { transactionId, message: error.message });
    });
  } catch (error) {
    logger.warn('receipt_pdf_enqueue_failed', { transactionId, message: error.message });
  }
};

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
  if (!sendMatch) {
    const regional = parseRegionalIntent(normalized);
    if (regional && regional.action === 'SEND') {
      return {
        amount: String(regional.amount),
        asset: regional.currency || NATIVE_ASSET,
        recipient: regional.recipient,
        ...(regional.memo ? { memo: regional.memo, memoType: regional.memoType || 'text' } : (memo ? { memo, memoType } : {})),
      };
    }
    return null;
  }
  return {
    amount: sendMatch[1],
    asset: sendMatch[2] ? sendMatch[2].toUpperCase() : NATIVE_ASSET,
    recipient: sendMatch[3].trim(),
    ...(memo ? { memo, memoType } : {}),
  };
};

const requestConfirmation = async ({ phoneNumber, user, intent, notify, selectedContact, db = defaultPrisma }) => {
  const resolveRecipient = createRecipientResolver({ prisma: db, walletService });
  const alias = !selectedContact && db.alias?.findUnique
    ? await db.alias.findUnique({
      where: { userId_alias: { userId: user.id, alias: String(intent.recipient).toLowerCase() } },
    })
    : null;
  const phoneCandidate = selectedContact?.target || alias?.target || intent.recipient;
  const recipientPhoneNumber = isValidPhoneNumber(phoneCandidate)
    ? canonicalizePhoneNumber(phoneCandidate)
    : undefined;
  let recipient;
  if (selectedContact) {
    const { label, target } = selectedContact;
    const destination = validateAddress(target) ? target
      : (await walletService.createOrGetWallet({ phoneNumber: canonicalizePhoneNumber(target) })).publicKey;
    recipient = { destination, label };
  } else {
    recipient = await resolveRecipient(user, intent.recipient);
  }
  const locale = user.locale || 'en';

  if (!selectedContact && recipient.destination === intent.recipient && !validateAddress(recipient.destination)) {
    const [aliases, contacts] = await Promise.all([
      db.alias.findMany?.({ where: { userId: user.id }, select: { alias: true, target: true } }) || [],
      db.contact?.findMany({ where: { ownerId: user.id, displayName: { not: null } },
        select: { displayName: true, phoneNumber: true } }) || [],
    ]);
    const namedContacts = [
      ...aliases.map(({ alias, target }) => ({ label: alias, target })),
      ...contacts.map(({ displayName, phoneNumber }) => ({ label: displayName, target: phoneNumber })),
    ].filter(({ target }) => validateAddress(target) || isValidPhoneNumber(target));
    const candidates = matchContacts(intent.recipient, namedContacts);
    if (candidates.length) {
      const token = crypto.randomBytes(12).toString('hex');
      await db.user.update({
        where: { id: user.id },
        data: { pendingSend: {
          step: 'AWAITING_CONTACT', token, intent, candidates,
          expiresAt: new Date(Date.now() + PENDING_SEND_TTL_MS).toISOString(),
        } },
      });
      if (candidates.length === 1) {
        await notify(phoneNumber, `Did you mean ${candidates[0].label}? Reply yes to select or no to cancel.`);
        return;
      }
      if (notify === sendTextMessage && config.messageTransport === 'meta') {
        try {
          await sendMetaMessage(phoneNumber, 'interactive', {
            type: 'list',
            body: { text: 'Which saved contact did you mean?' },
            action: {
              button: 'Choose contact',
              sections: [{ rows: candidates.map(({ label, target }, i) => ({
                id: `contact:${token}:${i + 1}`,
                title: Array.from(label).slice(0, 24).join(''),
                description: `Destination ending in ${target.slice(-4)}`,
              })) }],
            },
          }, AbortSignal.timeout(3000));
          return;
        } catch {
          logger.warn('whatsapp_contact_picker_failed');
        }
      }
      const choices = candidates.map(({ label, target }, i) => `${i + 1}. ${label} (ends in ${target.slice(-4)})`);
      await notify(phoneNumber, ['Which saved contact did you mean? Reply with its number or no to cancel.', ...choices].join('\n'));
      return;
    }
  }

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

  const quote = await createQuote({
    userId: user.id,
    sourceCurrency: intent.asset,
    targetCurrency: intent.asset,
    sourceAmount: intent.amount,
    route: 'stellar',
    provider: 'stellar',
  }).catch(() => null);

  const pendingSend = {
    version: 1,
    stateId,
    step,
    amount: intent.amount,
    asset: intent.asset,
    quoteId: quote?.id,
    quoteExpiresAt: quote?.expiresAt && new Date(quote.expiresAt).toISOString(),
    quoteFee: quote?.fee,
    destination: recipient.destination,
    alias: recipient.label,
    memo: intent.memo,
    memoType: intent.memoType,
    routeType: 'domestic',
    recipientPhoneNumber,
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
    const feeLine = quote?.fee ? `${t('payment_fee', { amount: formatAmountByLocale(quote.fee, intent.asset, locale) }, locale)}\n` : '';
    const quoteLine = quote?.expiresAt ? `Quote expires: ${new Date(quote.expiresAt).toISOString()}\n` : '';
    const confirmMsg = t('payment_confirm', {
      amount: formattedAmount,
      asset: intent.asset,
      label: recipient.label,
      memoLine,
      quoteLine: feeLine + quoteLine,
    }, locale);
    await notify(phoneNumber, confirmMsg);
  }
};

const handlePendingPin = async ({ phoneNumber, user, text, notify, db = defaultPrisma }) => {
  if (!user.pendingSend?.destination && user.pendingSend?.step !== 'AWAITING_CONTACT') return false;

  const locale = user.locale || 'en';
  const pendingState = user.pendingSend;
  const lowered = String(text).trim().toLowerCase();
  if (lowered.startsWith('contact:') && pendingState.step !== 'AWAITING_CONTACT') return true;

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

  if (pendingState.step === 'AWAITING_CONTACT') {
    const { candidates, token, intent } = pendingState;
    let index = 0;
    if (candidates.length === 1 && ['yes', 'oui', 'si'].includes(lowered)) index = 1;
    if (candidates.length > 1 && /^([1-9]|10)$/.test(lowered)) index = Number(lowered);
    if (lowered.startsWith(`contact:${token}:`)) index = Number(lowered.split(':')[2]);
    const selectedContact = Number.isInteger(index) && candidates[index - 1];
    if (!selectedContact) {
      await notify(phoneNumber, 'Select a contact from the current prompt or reply no to cancel.');
      return true;
    }
    await db.user.update({ where: { id: user.id }, data: { pendingSend: Prisma.DbNull } });
    await requestConfirmation({ phoneNumber, user, intent, selectedContact, notify, db });
    return true;
  }

  const isHighRiskStep = pendingState.step === 'AWAITING_HIGH_RISK_CONFIRMATION' || (pendingState.isHighRisk && !pendingState.highRiskConfirmed);

  if (isHighRiskStep) {
    if (lowered === 'yes' || lowered === 'oui' || lowered === 'si') {
      const now = new Date();
      const quoteExpiresAt = pendingState.quoteExpiresAt ? new Date(pendingState.quoteExpiresAt).getTime() : Infinity;
      const newExpiresAt = new Date(Math.min(now.getTime() + PENDING_SEND_TTL_MS, quoteExpiresAt));
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
      const feeLine = updatedPending.quoteFee ? `${t('payment_fee', {
        amount: formatAmountByLocale(updatedPending.quoteFee, updatedPending.asset, locale),
      }, locale)}\n` : '';
      const quoteLine = updatedPending.quoteExpiresAt ? `Quote expires: ${new Date(updatedPending.quoteExpiresAt).toISOString()}\n` : '';
      const confirmMsg = t('payment_confirm_high_risk', {
        amount: updatedPending.amount,
        asset: updatedPending.asset,
        fingerprint: updatedPending.fingerprint,
        memoLine,
        quoteLine: feeLine + quoteLine,
      }, locale);
      await notify(phoneNumber, confirmMsg);
      return true;
    } else {
      await notify(phoneNumber, t('invalid_high_risk_reply', {}, locale));
      return true;
    }
  }

  const userWithPin = await db.user.findUnique({ where: { id: user.id } });
  let pinOk = false;
  if (typeof verifyPinAttempt === 'function' && userWithPin && userWithPin.pinFailedAttempts !== undefined) {
    const pinAttempt = await verifyPinAttempt({ prisma: db, userId: user.id, pin: text });
    pinOk = pinAttempt.ok;
    if (!pinAttempt.ok && pinAttempt.locked) {
      const retrySeconds = Math.max(1, Math.ceil(pinAttempt.retryAfterMs / 1000));
      await notify(phoneNumber, `PIN verification failed. Your account is temporarily locked. Please try again in ${retrySeconds} seconds, or reply "no" to cancel.`);
      return true;
    }
  } else {
    pinOk = verifyPin(text, userWithPin?.pinHash);
  }

  if (!pinOk) {
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
    recipientPhoneNumber: pending.recipientPhoneNumber,
    destination: pending.destination,
    amount: pending.amount,
    asset: pending.asset,
    memo: pending.memo,
    memoType: pending.memoType,
    routeType: pending.routeType,
    ...(pending.quoteId ? { quoteId: pending.quoteId } : {}),
  });

  const standardReceipt = buildStandardReceipt(result.transaction, { mask: true });
  const receiptMsg = `${t('payment_success', {
    status: result.transaction.status,
    receiptId: result.receipt?.transactionId || standardReceipt.transactionId,
  }, locale)}\n\n${formatChannelReceiptMessage(standardReceipt)}`;

  const voiceReceipt = notify === sendTextMessage
    ? sendVoiceReceipt({
        phoneNumber, transaction: result.transaction, label: pending.alias, ledgerConfirmed: result.ledgerConfirmed,
      }).catch(() => {
        logger.warn('whatsapp_voice_receipt_failed', { transactionId: result.transaction.id });
      })
    : Promise.resolve();
  await notify(phoneNumber, receiptMsg, {
    notification: {
      userId: user.id,
      type: 'transaction_receipt',
      referenceType: 'transaction',
      referenceId: result.transaction.id,
    },
  });
  await voiceReceipt;
  queuePdfReceipt(result.transaction.id);
  return true;
};

const processMessage = async (phoneNumber, whatsappName, text, options = {}) => {
  const notify = typeof options === 'function' ? options : (options.notify || sendTextMessage);
  const db = options.prisma || defaultPrisma;

  const user = await resolveUser(phoneNumber, whatsappName, db);
  const locale = user.locale || 'en';

  const normalized = String(text || '').trim().toLowerCase();
  const activeHandoff = db.supportCase?.findFirst
    ? await findOpenHandoff(db, user.id)
    : null;
  if (activeHandoff) {
    await notify(phoneNumber, `Your support request ${activeHandoff.caseNumber} is with our human support team. Automated assistance will resume after the case is closed.`);
    return;
  }

  // Language/locale selection command (#192)
  const langMatch = normalized.match(/^(?:lang|language|locale)\s+([a-z]{2})$/i);
  if (langMatch) {
    await resetUnrecognizedCount({ prisma: db, user });
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
    await resetUnrecognizedCount({ prisma: db, user });
    // Applies the keyword across every optional category, not just the
    // global flag: a customer who says STOP means stop, and leaving service
    // messages running because they are "useful" is what erodes trust in the
    // keyword (#310).
    const { user: updatedUser } = await applyConsentKeyword({
      userId: user.id,
      phoneNumber,
      consent: consentCmd.consent,
      prisma: db,
    });
    user.messagingConsent = updatedUser.messagingConsent;
    const msgKey = consentCmd.consent === 'opted_out' ? 'opt_out_success' : 'opt_in_success';
    await notify(phoneNumber, t(msgKey, {}, user.locale));
    return;
  }

  // Recurring payment mandates (#1005): schedule/list/pause/resume/cancel and
  // the PIN reply that activates a schedule. A pending one-off send keeps
  // priority for bare PIN replies.
  if (await handleRecurringMessage({
    phoneNumber, user, text, notify, prisma: db, hasPendingSend: Boolean(user.pendingSend?.destination),
  })) {
    await resetUnrecognizedCount({ prisma: db, user });
    return;
  }

  if (await handlePendingPin({ phoneNumber, user, text, notify, db })) {
    await resetUnrecognizedCount({ prisma: db, user });
    return;
  }
  if (normalized.startsWith('contact:')) return;

  if (normalized === 'help') {
    const supportCase = await handoffByRequest({ prisma: db, user });
    await notify(phoneNumber, `I've connected you with human support. Your case number is ${supportCase.caseNumber}. Automated assistance will resume after the case is closed.`);
    return;
  }

  if (['hi', 'hello', 'menu'].includes(normalized)) {
    await resetUnrecognizedCount({ prisma: db, user });
    if (!isMessageAllowed({ user, isTransactional: false })) {
      await notify(phoneNumber, t('opted_out_blocked', {}, locale));
      return;
    }
    await notify(phoneNumber, t('welcome_help', {}, locale));
    return;
  }

  if (normalized.includes('balance')) {
    await resetUnrecognizedCount({ prisma: db, user });
    await walletService.ensureWalletsForUser({ user });
    const balances = await walletService.balancesForUser({ userId: user.id });
    const lines = balances.flatMap((b) => {
      if (b.error) return [`${b.chain}: unavailable (${b.error})`];
      return (b.assets || []).map((a) => {
        const total = `${a.asset}: ${formatAmountByLocale(a.value, a.asset, locale)}`;
        return a.spendable === undefined ? total : `${total} (${t('balance_spendable', {
          amount: formatAmountByLocale(a.spendable, a.asset, locale),
        }, locale)})`;
      });
    });
    const headerMsg = t('balances_header', { lines: lines.join('\n') }, locale);
    await notify(phoneNumber, headerMsg);
    return;
  }

  if (normalized.includes('receive')) {
    await resetUnrecognizedCount({ prisma: db, user });
    const wallets = await walletService.ensureWalletsForUser({ user });
    const lines = wallets.map((w) => `${w.chain}: ${w.publicKey}`);
    const headerMsg = t('receive_header', { lines: lines.join('\n') }, locale);
    await notify(phoneNumber, headerMsg);
    return;
  }

  if (normalized.includes('history') || normalized.includes('transactions')) {
    await resetUnrecognizedCount({ prisma: db, user });
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
    await resetUnrecognizedCount({ prisma: db, user });
    await requestConfirmation({ phoneNumber, user, intent: paymentIntent, notify, db });
    return;
  }

  const handoff = await handoffUnrecognizedMessage({ prisma: db, user });
  if (handoff.escalated) {
    await notify(phoneNumber, `I've connected you with human support. Your case number is ${handoff.supportCase.caseNumber}. Automated assistance is paused until the case is closed.`);
    return;
  }
  await notify(phoneNumber, t('fallback_menu', {}, locale));
};

module.exports = {
  processMessage,
  parsePaymentIntent,
};
