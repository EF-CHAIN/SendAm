const walletService = require('../wallet/wallet.service');
const { detectChainFromAddress } = require('../wallet/chainRegistry');
const { executePayment } = require('../payment/payment.orchestrator');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { verifyPin } = require('../compliance/pin.service');
const { sendTextMessage } = require('../services/whatsapp.service');
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

const resolveRecipient = async (user, recipient) => {
  const alias = String(recipient || '').trim().toLowerCase();
  const savedAlias = await prisma.alias.findUnique({
    where: { userId_alias: { userId: user.id, alias } },
  });
  if (savedAlias) return { destination: savedAlias.target, label: alias };
  return { destination: recipient, label: recipient };
};

const requestConfirmation = async ({ phoneNumber, user, intent }) => {
  const recipient = await resolveRecipient(user, intent.recipient);

  if (!detectChainFromAddress(recipient.destination)) {
    await sendTextMessage(
      phoneNumber,
      `"${recipient.label}" isn't a saved contact or a recognized wallet address (Stellar or Lisk). Save it first, or send to a valid address directly.`
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

  await sendTextMessage(
    phoneNumber,
    `Please confirm this payment:\nAmount: ${intent.amount} ${intent.asset}\nTo: ${recipient.label}\nReply with your PIN to send, or "no" to cancel.`
  );
};

const handlePendingPin = async ({ phoneNumber, user, text }) => {
  if (!user.pendingSend?.destination) return false;

  const lowered = String(text).trim().toLowerCase();
  if (lowered === 'no' || lowered === 'cancel') {
    await prisma.user.update({ where: { id: user.id }, data: { pendingSend: null } });
    await sendTextMessage(phoneNumber, 'Payment cancelled.');
    return true;
  }

  if (Date.now() - new Date(user.pendingSend.requestedAt).getTime() > PENDING_SEND_TTL_MS) {
    await prisma.user.update({ where: { id: user.id }, data: { pendingSend: null } });
    await sendTextMessage(phoneNumber, 'That payment request expired. Please start again.');
    return true;
  }

  const userWithPin = await prisma.user.findUnique({ where: { id: user.id } });
  if (!verifyPin(text, userWithPin.pinHash)) {
    await sendTextMessage(phoneNumber, 'PIN verification failed. Please try again or reply "no" to cancel.');
    return true;
  }

  const pending = user.pendingSend;
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

  await prisma.user.update({ where: { id: user.id }, data: { pendingSend: null } });

  await sendTextMessage(phoneNumber, `Payment ${result.transaction.status}. Receipt: ${result.receipt.transactionId}`);
  return true;
};

const processMessage = async (phoneNumber, whatsappName, text) => {
  const user = await resolveUser(phoneNumber, whatsappName);
  if (await handlePendingPin({ phoneNumber, user, text })) return;

  const normalized = String(text || '').trim().toLowerCase();

  if (['hi', 'hello', 'help', 'menu'].includes(normalized)) {
    await sendTextMessage(phoneNumber, 'SendAm can help with send money, receive money, balance, escrow, nearby cash-out, contacts, transaction history, and receipts.');
    return;
  }

  if (normalized.includes('balance')) {
    await walletService.ensureWalletsForUser({ user });
    const balances = await walletService.balancesForUser({ userId: user.id });
    const lines = balances.map((b) => (b.value !== null ? `${b.chain}: ${b.value}` : `${b.chain}: unavailable (${b.error})`));
    await sendTextMessage(phoneNumber, `Your SendAm balances:\n${lines.join('\n')}`);
    return;
  }

  if (normalized.includes('receive')) {
    const wallets = await walletService.ensureWalletsForUser({ user });
    const lines = wallets.map((w) => `${w.chain}: ${w.publicKey}`);
    await sendTextMessage(phoneNumber, `Share one of these to receive money on SendAm:\n${lines.join('\n')}`);
    return;
  }

  if (normalized.includes('history') || normalized.includes('transactions')) {
    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const lines = transactions.map((tx) => `${tx.type}: ${tx.amount} ${tx.asset} - ${tx.status}`);
    await sendTextMessage(phoneNumber, lines.length ? lines.join('\n') : 'No transactions yet.');
    return;
  }

  if (normalized.includes('cash-out') || normalized.includes('cash out') || normalized.includes('nearby')) {
    await sendTextMessage(phoneNumber, 'Nearby cash-out is being routed to verified agents. Please share your area or enable the WhatsApp location flow.');
    return;
  }

  if (normalized.includes('escrow')) {
    await sendTextMessage(phoneNumber, 'Escrow is available for protected payments. Tell me the amount, recipient, and release terms.');
    return;
  }

  const paymentIntent = parsePaymentIntent(text);
  if (paymentIntent) {
    await requestConfirmation({ phoneNumber, user, intent: paymentIntent });
    return;
  }

  await sendTextMessage(phoneNumber, 'I can help you send money, check balance, receive money, start escrow, find cash-out agents, or show receipts.');
};

module.exports = {
  processMessage,
  parsePaymentIntent,
};
