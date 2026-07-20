const { Prisma } = require('@prisma/client');
const walletService = require('../wallet/wallet.service');
const { validateAddress } = require('../wallet/stellar.adapter');
const { executePayment } = require('../payment/payment.orchestrator');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { verifyPin } = require('../compliance/pin.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const { aiClient } = require('../services/aiClient');
const { nsClient } = require('../services/nsClient');
const { claimPendingSend } = require('./pendingClaim');
const { createRecipientResolver } = require('./recipientResolver');
const prisma = require('../common/prisma');

const PENDING_SEND_TTL_MS = 10 * 60 * 1000;

const resolveUser = async (phoneNumber, whatsappName) => {
  let user = await prisma.user.findUnique({ where: { phoneNumber } });
  if (!user) {
    user = await prisma.user.create({ data: { phoneNumber, whatsappName } });
  } else if (whatsappName && user.whatsappName !== whatsappName) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { whatsappName },
    });
  }
  return user;
};

const parsePaymentIntent = (text) => {
  const normalized = String(text || '').trim();
  const sendMatch = normalized.match(/(?:send|pay|transfer)\s+([\d.]+)\s*([a-zA-Z]{2,5})?\s+(?:to\s+)?(.+)/i);
  if (!sendMatch) return null;

  return {
    amount: sendMatch[1],
    // No unit specified — let payment.orchestrator default to the
    // destination chain's native asset instead of guessing here.
    asset: sendMatch[2] ? sendMatch[2].toUpperCase() : undefined,
    recipient: sendMatch[3].trim(),
  };
};

// Precedence: saved contacts → sigil-prefixed global names via sendam-ns →
// raw address passthrough. See recipientResolver.js; the address-validity
// check in requestConfirmation still applies to whatever comes back.
const resolveRecipient = createRecipientResolver({ prisma, nsClient });

const requestConfirmation = async ({ phoneNumber, user, intent, notify }) => {
  const recipient = await resolveRecipient(user, intent.recipient);

  if (!validateAddress(String(recipient.destination || '').trim())) {
    await notify(
      phoneNumber,
      `"${recipient.label}" isn't a saved contact or a valid Stellar address. Save it first, or send to a valid address directly.`
    );
    return;
  }

  const pendingSend = {
    amount: intent.amount,
    asset: intent.asset,
    destination: recipient.destination,
    alias: recipient.label,
    routeType: 'domestic',
    requestedAt: new Date(),
  };
  await prisma.user.update({
    where: { id: user.id },
    data: { pendingSend },
  });

  await notify(
    phoneNumber,
    `Please confirm this payment:\nAmount: ${intent.amount} ${intent.asset}\nTo: ${recipient.label}\nReply with your PIN to send, or "no" to cancel.`
  );
};

const handlePendingPin = async ({ phoneNumber, user, text, notify }) => {
  if (!user.pendingSend?.destination) return false;

  const lowered = String(text).trim().toLowerCase();
  if (lowered === 'no' || lowered === 'cancel') {
    // Json? columns need Prisma.DbNull — a plain null in `data` throws at runtime.
    await prisma.user.update({ where: { id: user.id }, data: { pendingSend: Prisma.DbNull } });
    await notify(phoneNumber, 'Payment cancelled.');
    return true;
  }

  if (Date.now() - new Date(user.pendingSend.requestedAt).getTime() > PENDING_SEND_TTL_MS) {
    await prisma.user.update({ where: { id: user.id }, data: { pendingSend: Prisma.DbNull } });
    await notify(phoneNumber, 'That payment request expired. Please start again.');
    return true;
  }

  const userWithPin = await prisma.user.findUnique({ where: { id: user.id } });
  if (!verifyPin(text, userWithPin.pinHash)) {
    await notify(phoneNumber, 'PIN verification failed. Please try again or reply "no" to cancel.');
    return true;
  }

  // Atomically claim (clear) the pending send BEFORE executing. Two
  // concurrent messages with a valid PIN both reach this point — the claim
  // guarantees exactly one of them executes the payment; the loser gets a
  // clear reply instead of a double spend. A payment that fails after the
  // claim requires the user to start the send again — the safe direction.
  const pending = user.pendingSend;
  if (!(await claimPendingSend({ prisma, Prisma, userId: user.id }))) {
    await notify(phoneNumber, 'That payment was already processed or cancelled.');
    return true;
  }

  await enforceTransactionPolicy({
    user,
    amount: pending.amount,
    routeType: pending.routeType,
    destinationCountry: 'NG',
  });

  const result = await executePayment({
    sender: user,
    destination: pending.destination,
    amount: pending.amount,
    asset: pending.asset,
    routeType: pending.routeType,
  });

  await notify(phoneNumber, `Payment ${result.transaction.status}. Receipt: ${result.receipt.transactionId}`);
  return true;
};

// `notify` defaults to the real WhatsApp send so the webhook path (the only
// caller before the sim endpoints existed) is unaffected. The sim controller
// passes its own `notify` to capture replies inline instead of calling Meta —
// see apps/api/src/controllers/sim.controller.js.
const processMessage = async (phoneNumber, whatsappName, text, { notify = sendTextMessage } = {}) => {
  const user = await resolveUser(phoneNumber, whatsappName);
  if (await handlePendingPin({ phoneNumber, user, text, notify })) return;

  const normalized = String(text || '').trim().toLowerCase();

  if (['hi', 'hello', 'help', 'menu'].includes(normalized)) {
    await notify(phoneNumber, 'SendAm can help with send money, receive money, balance, contacts, transaction history, and receipts.');
    return;
  }

  if (normalized.includes('balance')) {
    await walletService.ensureWalletsForUser({ user });
    const balances = await walletService.balancesForUser({ userId: user.id });
    const lines = balances.map((b) => (b.value !== null ? `${b.chain}: ${b.value}` : `${b.chain}: unavailable (${b.error})`));
    await notify(phoneNumber, `Your SendAm balances:\n${lines.join('\n')}`);
    return;
  }

  if (normalized.includes('receive')) {
    const wallets = await walletService.ensureWalletsForUser({ user });
    const lines = wallets.map((w) => `${w.chain}: ${w.publicKey}`);
    await notify(phoneNumber, `Share one of these to receive money on SendAm:\n${lines.join('\n')}`);
    return;
  }

  if (normalized.includes('history') || normalized.includes('transactions')) {
    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const lines = transactions.map((tx) => `${tx.type}: ${tx.amount} ${tx.asset} - ${tx.status}`);
    await notify(phoneNumber, lines.length ? lines.join('\n') : 'No transactions yet.');
    return;
  }

  // Regex parser stays PRIMARY. The AI decoder is a guarded fallback for
  // messages the regex can't classify — it only ever proposes; a decoded
  // send re-enters the exact same confirmation + PIN + policy guardrails.
  // Off or unreachable, this is a no-op and the help fallback below answers.
  let paymentIntent = parsePaymentIntent(text);
  if (!paymentIntent && aiClient.enabled) {
    paymentIntent = await aiClient.decodeToPaymentIntent(text, user.id);
  }
  if (paymentIntent) {
    await requestConfirmation({ phoneNumber, user, intent: paymentIntent, notify });
    return;
  }

  await notify(phoneNumber, 'I can help you send money, check balance, receive money, or show receipts.');
};

module.exports = {
  processMessage,
  parsePaymentIntent,
};
