const walletService = require('../wallet/wallet.service');
const { validateAddress } = require('../wallet/stellar.adapter');
const { executePayment } = require('../payment/payment.orchestrator');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { verifyPin } = require('../compliance/pin.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const { confirmationService } = require('./paymentConfirmation.service');
const { createRecipientResolver } = require('./recipientResolver');
const prisma = require('../common/prisma');

const NATIVE_ASSET = 'XLM';

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
  const sendMatch = normalized.match(
    /(?:send|pay|transfer)\s+([\d.]+)\s*((?!to\b)[a-zA-Z]{2,5})?\s+(?:to\s+)?(.+)/i
  );
  if (!sendMatch) return null;
  return {
    amount: sendMatch[1],
    // No unit specified — name the native asset here rather than leaving it
    // undefined. payment.orchestrator resolves the same default (NATIVE_ASSET),
    // but the confirmation message is built from this value, so leaving it
    // undefined showed the user "Amount: 10 undefined".
    asset: sendMatch[2] ? sendMatch[2].toUpperCase() : NATIVE_ASSET,
    recipient: sendMatch[3].trim(),
  };
};

// Precedence: saved contacts → phone numbers → raw address passthrough. See
// recipientResolver.js; the address-validity check in requestConfirmation
// still applies to whatever comes back.
const resolveRecipient = createRecipientResolver({ prisma, walletService });

const requestConfirmation = async ({ phoneNumber, user, intent, notify }) => {
  const recipient = await resolveRecipient(user, intent.recipient);

  if (!validateAddress(String(recipient.destination || '').trim())) {
    await notify(
      phoneNumber,
      `"${recipient.label}" isn't a saved contact or a valid Stellar address. Save it first, or send to a valid address directly.`
    );
    return;
  }

  const confirmation = await confirmationService.create({
    userId: user.id,
    amount: intent.amount,
    asset: intent.asset,
    destination: recipient.destination,
    recipientLabel: recipient.label,
    routeType: 'domestic',
  });

  await notify(
    phoneNumber,
    `Please confirm payment ${confirmation.reference}:\nAmount: ${intent.amount} ${intent.asset}\nTo: ${recipient.label}\nReply with "<PIN> ${confirmation.reference}" to send, or "cancel ${confirmation.reference}".`
  );
};

const handlePendingPin = async ({ phoneNumber, user, text, notify }) => {
  const lowered = String(text).trim().toLowerCase();
  const reference = String(text).toUpperCase().match(/\b[A-F0-9]{6}\b/)?.[0];
  const hasPending = await confirmationService.hasPending(user.id);
  if (!reference) {
    if (!hasPending) return false;
    await notify(phoneNumber, 'Include the 6-character payment reference from the prompt so I confirm the right payment.');
    return true;
  }

  const pending = await confirmationService.find(user.id, reference);
  if (!pending) {
    await notify(phoneNumber, `Payment reference ${reference} was not found.`);
    return true;
  }
  if (pending.state !== 'pending') {
    await notify(phoneNumber, `Payment ${reference} is ${pending.state} and cannot be authorized.`);
    return true;
  }
  if (lowered.startsWith('cancel ') || lowered.startsWith('no ')) {
    // Json? columns need Prisma.DbNull — a plain null in `data` throws at runtime.
    const cancelled = await confirmationService.cancel(pending);
    await notify(phoneNumber, cancelled ? `Payment ${reference} cancelled.` : `Payment ${reference} was already handled.`);
    return true;
  }

  if (pending.expiresAt <= new Date()) {
    await confirmationService.expire(pending);
    await notify(phoneNumber, `Payment ${reference} expired. Please start again.`);
    return true;
  }

  const userWithPin = await prisma.user.findUnique({ where: { id: user.id } });
  const pin = String(text).trim().split(/\s+/)[0];
  if (!verifyPin(pin, userWithPin.pinHash)) {
    await notify(phoneNumber, `PIN verification failed. Try again with "<PIN> ${reference}" or cancel ${reference}.`);
    return true;
  }

  // Atomically claim (clear) the pending send BEFORE executing. Two
  // concurrent messages with a valid PIN both reach this point — the claim
  // guarantees exactly one of them executes the payment; the loser gets a
  // clear reply instead of a double spend. A payment that fails after the
  // claim requires the user to start the send again — the safe direction.
  if (!(await confirmationService.authorize(pending))) {
    await notify(phoneNumber, `Payment ${reference} was already processed, cancelled, superseded, or expired.`);
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

  await confirmationService.complete(pending.id, result.transaction.id);

  await notify(phoneNumber, `Payment ${reference} ${result.transaction.status}. Receipt: ${result.receipt.transactionId}`);
  return true;
};

// `notify` defaults to the real WhatsApp send so the webhook path (the only
// caller before the sim endpoints existed) is unaffected. The sim controller
// passes its own `notify` to capture replies inline instead of calling Meta —
// see apps/api/src/controllers/sim.controller.js.
const processMessage = async (phoneNumber, whatsappName, text, { notify = sendTextMessage } = {}) => {
  const user = await resolveUser(phoneNumber, whatsappName);
  const paymentIntent = parsePaymentIntent(text);
  if (paymentIntent) {
    await requestConfirmation({ phoneNumber, user, intent: paymentIntent, notify });
    return;
  }
  if (await handlePendingPin({ phoneNumber, user, text, notify })) return;

  const normalized = String(text || '').trim().toLowerCase();

  if (['hi', 'hello', 'help', 'menu'].includes(normalized)) {
    await notify(phoneNumber, 'SendAm can help with send money, receive money, balance, contacts, transaction history, and receipts.');
    return;
  }

  if (normalized.includes('balance')) {
    await walletService.ensureWalletsForUser({ user });
    const balances = await walletService.balancesForUser({ userId: user.id });
    const lines = balances.flatMap((b) => {
      if (b.error) return [`${b.chain}: unavailable (${b.error})`];
      return (b.assets || []).map((a) => `${a.asset}: ${a.value}`);
    });
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

  await notify(phoneNumber, 'I can help you send money, check balance, receive money, or show receipts.');
};

module.exports = {
  processMessage,
  parsePaymentIntent,
};
