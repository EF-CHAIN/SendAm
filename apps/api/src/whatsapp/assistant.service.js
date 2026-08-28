const { validateAddress } = require('../wallet/stellar.adapter');
const { verifyAndUpgradePin } = require('../compliance/pin.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const { claimPendingSend } = require('./pendingClaim');
const { createRecipientResolver } = require('./recipientResolver');
const { isValidPhoneNumber } = require('../utils/validators');

const getExecutePayment = () => {
  try {
    return require('../payment/payment.orchestrator').executePayment;
  } catch (_error) {
    return null;
  }
};

const getEnforceTransactionPolicy = () => {
  try {
    return require('../compliance/compliance.service').enforceTransactionPolicy;
  } catch (_error) {
    return null;
  }
};

const getPrisma = () => {
  try {
    return require('../common/prisma');
  } catch (_error) {
    return null;
  }
};

const getWalletService = () => {
  try {
    return require('../wallet/wallet.service');
  } catch (_error) {
    return null;
  }
};

const getPrismaNamespace = () => {
  try {
    return require('@prisma/client');
  } catch (_error) {
    return { DbNull: null, AnyNull: null };
  }
};

const PENDING_SEND_TTL_MS = 10 * 60 * 1000;

const parsePaymentIntent = (text) => {
  const normalized = String(text || '').trim();
  const sendMatch = normalized.match(
    /(?:send|pay|transfer)\s+([\d.]+)\s*((?!to\b)[a-zA-Z]{2,5})?\s+(?:to\s+)?(.+)/i
  );
  if (!sendMatch) return null;

  return {
    amount: sendMatch[1],
    asset: sendMatch[2] ? sendMatch[2].toUpperCase() : undefined,
    recipient: sendMatch[3].trim(),
  };
};

const resolveUser = async ({ prismaClient, phoneNumber, whatsappName }) => {
  let user = await prismaClient.user.findUnique({ where: { phoneNumber } });
  if (!user) {
    user = await prismaClient.user.create({ data: { phoneNumber, whatsappName } });
  } else if (whatsappName && user.whatsappName !== whatsappName) {
    user = await prismaClient.user.update({
      where: { id: user.id },
      data: { whatsappName },
    });
  }
  return user;
};

function createAssistantService({
  prisma: prismaClient = getPrisma(),
  walletService = getWalletService(),
  notify = sendTextMessage,
} = {}) {
  const resolveRecipient = createRecipientResolver({ prisma: prismaClient, walletService });

  const requestConfirmation = async ({ phoneNumber, user, intent, notify: notifyFn = notify }) => {
    const recipient = await resolveRecipient(user, intent.recipient);
    const confirmed = {
      destination: recipient.destination,
      label: recipient.label,
    };

    if (isValidPhoneNumber(recipient.destination)) {
      const wallet = await walletService.createOrGetWallet({ phoneNumber: recipient.destination });
      confirmed.destination = wallet.publicKey;
      confirmed.label = recipient.destination;
    }

    if (recipient.destination && validateAddress && typeof validateAddress === 'function') {
      const isValidAddress = validateAddress(recipient.destination);
      if (!isValidAddress && !isValidPhoneNumber(recipient.destination)) {
        throw new Error(`The recipient address is invalid: ${recipient.destination}`);
      }
    }

    const pendingSend = {
      amount: intent.amount,
      asset: intent.asset,
      destination: confirmed.destination,
      alias: confirmed.label,
      routeType: 'domestic',
      requestedAt: new Date(),
    };

    await prismaClient.user.update({
      where: { id: user.id },
      data: { pendingSend },
    });

    await notifyFn(
      phoneNumber,
      `Please confirm this payment:\nAmount: ${intent.amount} ${intent.asset}\nTo: ${confirmed.label}\nReply with your PIN to send, or "no" to cancel.`
    );

    return confirmed;
  };

  const handlePendingPin = async ({ phoneNumber, user, text, notify: notifyFn = notify }) => {
    if (!user.pendingSend?.destination) return false;

    const lowered = String(text).trim().toLowerCase();
    const PrismaNs = getPrismaNamespace();
    if (lowered === 'no' || lowered === 'cancel') {
      await prismaClient.user.update({ where: { id: user.id }, data: { pendingSend: PrismaNs.DbNull } });
      await notifyFn(phoneNumber, 'Payment cancelled.');
      return true;
    }

    if (Date.now() - new Date(user.pendingSend.requestedAt).getTime() > PENDING_SEND_TTL_MS) {
      await prismaClient.user.update({ where: { id: user.id }, data: { pendingSend: PrismaNs.DbNull } });
      await notifyFn(phoneNumber, 'That payment request expired. Please start again.');
      return true;
    }

    const userWithPin = await prismaClient.user.findUnique({ where: { id: user.id } });
    const verification = verifyAndUpgradePin(text, userWithPin.pinHash || null);
    if (!verification.valid) {
      await notifyFn(phoneNumber, 'PIN verification failed. Please try again or reply "no" to cancel.');
      return true;
    }

    if (verification.upgraded && verification.hash && verification.hash !== userWithPin.pinHash) {
      await prismaClient.user.update({
        where: { id: user.id },
        data: { pinHash: verification.hash, pinSetAt: new Date() },
      });
    }

    const pending = user.pendingSend;
    if (!(await claimPendingSend({ prisma: prismaClient, Prisma: getPrismaNamespace(), userId: user.id }))) {
      await notifyFn(phoneNumber, 'That payment was already processed or cancelled.');
      return true;
    }

    const enforceTransactionPolicy = getEnforceTransactionPolicy();
    if (enforceTransactionPolicy) {
      await enforceTransactionPolicy({
        user,
        amount: pending.amount,
        routeType: pending.routeType,
        destinationCountry: 'NG',
      });
    }

    const executePayment = getExecutePayment();
    if (!executePayment) {
      throw new Error('Payment orchestration is unavailable.');
    }

    const result = await executePayment({
      sender: user,
      destination: pending.destination,
      amount: pending.amount,
      asset: pending.asset,
      routeType: pending.routeType,
    });

    await notifyFn(phoneNumber, `Payment ${result.transaction.status}. Receipt: ${result.receipt.transactionId}`);
    return true;
  };

  const processMessage = async (phoneNumber, whatsappName, text, { notify: notifyFn = notify } = {}) => {
    const user = await resolveUser({ prismaClient, phoneNumber, whatsappName });
    if (await handlePendingPin({ phoneNumber, user, text, notify: notifyFn })) return;

    const normalized = String(text || '').trim().toLowerCase();

    if (['hi', 'hello', 'help', 'menu'].includes(normalized)) {
      await notifyFn(phoneNumber, 'SendAm can help with send money, receive money, balance, contacts, transaction history, and receipts.');
      return;
    }

    if (normalized.includes('balance')) {
      await walletService.ensureWalletsForUser({ user });
      const balances = await walletService.balancesForUser({ userId: user.id });
      const lines = balances.flatMap((b) => {
        if (b.error) return [`${b.chain}: unavailable (${b.error})`];
        return (b.assets || []).map((a) => `${a.asset}: ${a.value}`);
      });
      await notifyFn(phoneNumber, `Your SendAm balances:\n${lines.join('\n')}`);
      return;
    }

    if (normalized.includes('receive')) {
      const wallets = await walletService.ensureWalletsForUser({ user });
      const lines = wallets.map((w) => `${w.chain}: ${w.publicKey}`);
      await notifyFn(phoneNumber, `Share one of these to receive money on SendAm:\n${lines.join('\n')}`);
      return;
    }

    if (normalized.includes('history') || normalized.includes('transactions')) {
      const transactions = await prismaClient.transaction.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      const lines = transactions.map((tx) => `${tx.type}: ${tx.amount} ${tx.asset} - ${tx.status}`);
      await notifyFn(phoneNumber, lines.length ? lines.join('\n') : 'No transactions yet.');
      return;
    }

    const paymentIntent = parsePaymentIntent(text);
    if (paymentIntent) {
      await requestConfirmation({ phoneNumber, user, intent: paymentIntent, notify: notifyFn });
      return;
    }

    await notifyFn(phoneNumber, 'I can help you send money, check balance, receive money, or show receipts.');
  };

  return {
    processMessage,
    parsePaymentIntent,
    handlePendingPin,
    requestConfirmation,
    resolveUser,
  };
}

const processMessage = async (phoneNumber, whatsappName, text, options = {}) => {
  const service = createAssistantService();
  return service.processMessage(phoneNumber, whatsappName, text, options);
};

module.exports = {
  createAssistantService,
  processMessage,
  parsePaymentIntent,
};
