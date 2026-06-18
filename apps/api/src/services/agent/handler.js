const { parseIntent } = require('./intents');
const { replies, shortenPublicKey } = require('./replies');
const { sendTextMessage } = require('../whatsapp.service');
const { createWalletForUser, getWalletByUserId, markWalletFunded } = require('../wallet.service');
const { getBalance, fundAccount, isValidPublicKey } = require('../stellar.service');
const { executeSend } = require('../transaction.service');
const User = require('../../models/User');
const logger = require('../../utils/logger');

const PENDING_SEND_TTL_MS = 10 * 60 * 1000;

/**
 * Entry point for the WhatsApp agent. Resolves the user, classifies the
 * message, and dispatches to the matching handler. The dispatch map (not a
 * switch) is what keeps adding new flows cheap: register an intent in
 * intents.js and a handler here.
 */
const processMessage = async (phoneNumber, whatsappName, text) => {
  const user = await resolveUser(phoneNumber, whatsappName);
  const { type, payload } = parseIntent(text);

  const handler = handlers[type] || handlers.UNKNOWN;
  await handler({ phoneNumber, whatsappName, user, payload });
};

const resolveUser = async (phoneNumber, whatsappName) => {
  let user = await User.findOne({ phoneNumber });
  if (!user) {
    user = await User.create({ phoneNumber, whatsappName });
  } else if (whatsappName && user.whatsappName !== whatsappName) {
    user.whatsappName = whatsappName;
    await user.save();
  }
  return user;
};

const handleGreeting = async ({ phoneNumber, whatsappName }) => {
  await sendTextMessage(phoneNumber, replies.greeting(whatsappName));
};

const handleHelp = async ({ phoneNumber }) => {
  await sendTextMessage(phoneNumber, replies.help());
};

// Fund (or re-fund) a wallet on Testnet and mark it funded on success.
// Friendbot retries live in stellar.service; if it still fails we tell the
// user how to retry rather than leaving them stranded with an empty wallet.
const fundWallet = async ({ phoneNumber, wallet }) => {
  try {
    await fundAccount(wallet.publicKey);
    await markWalletFunded(wallet._id);
    await sendTextMessage(phoneNumber, replies.walletReady(wallet.publicKey));
  } catch (error) {
    logger.error(`Funding failed for ${wallet.publicKey}:`, error.message);
    await sendTextMessage(phoneNumber, replies.fundingFailed());
  }
};

const handleCreateWallet = async ({ phoneNumber, user }) => {
  let wallet = await getWalletByUserId(user._id);

  // Already funded — nothing to do but echo their public key.
  if (wallet && wallet.funded) {
    await sendTextMessage(phoneNumber, replies.walletExists(wallet.publicKey));
    return;
  }

  // Either no wallet yet, or one whose funding never completed. Create if
  // needed, then (re)attempt funding so a prior Friendbot hiccup self-heals.
  if (!wallet) {
    wallet = await createWalletForUser(user._id);
  }

  await sendTextMessage(phoneNumber, replies.creatingWallet());
  await fundWallet({ phoneNumber, wallet });
};

const handleFundWallet = async ({ phoneNumber, user }) => {
  const wallet = await getWalletByUserId(user._id);
  if (!wallet) {
    await sendTextMessage(phoneNumber, replies.noWallet());
    return;
  }
  if (wallet.funded) {
    await sendTextMessage(phoneNumber, replies.alreadyFunded(wallet.publicKey));
    return;
  }

  await sendTextMessage(phoneNumber, replies.fundingWallet());
  await fundWallet({ phoneNumber, wallet });
};

const handleBalance = async ({ phoneNumber, user }) => {
  try {
    const wallet = await getWalletByUserId(user._id);
    if (!wallet) {
      await sendTextMessage(phoneNumber, replies.noWallet());
      return;
    }

    const balance = await getBalance(wallet.publicKey);
    await sendTextMessage(phoneNumber, replies.balance(balance));
  } catch (error) {
    await sendTextMessage(phoneNumber, replies.balanceError(error.message));
  }
};

const handleSaveContact = async ({ phoneNumber, user, payload }) => {
  try {
    const { alias, publicKey } = payload;
    if (!isValidPublicKey(publicKey)) {
      await sendTextMessage(phoneNumber, replies.invalidPublicKey());
      return;
    }

    user.contacts = (user.contacts || []).filter((contact) => contact.alias !== alias);
    user.contacts.push({ alias, publicKey });
    await user.save();

    await sendTextMessage(phoneNumber, replies.contactSaved(alias, publicKey));
  } catch (error) {
    await sendTextMessage(phoneNumber, replies.contactSaveError(error.message));
  }
};

const handleListContacts = async ({ phoneNumber, user }) => {
  if (!user.contacts || user.contacts.length === 0) {
    await sendTextMessage(phoneNumber, replies.noContacts());
    return;
  }
  await sendTextMessage(phoneNumber, replies.contactList(user.contacts));
};

const handlePrepareSend = async ({ phoneNumber, user, payload }) => {
  try {
    const wallet = await getWalletByUserId(user._id);
    if (!wallet) {
      await sendTextMessage(phoneNumber, replies.noWallet());
      return;
    }

    const { amount, recipient } = payload;
    const resolved = resolveRecipient(user, recipient);

    if (!resolved.destination) {
      await sendTextMessage(phoneNumber, replies.recipientNotFound(recipient));
      return;
    }

    // Pre-flight balance check: catch "sending more than you have" before the
    // user confirms, instead of letting it fail on-ledger after they reply YES.
    const balance = await getBalance(wallet.publicKey);
    if (Number(balance) < Number(amount)) {
      await sendTextMessage(phoneNumber, replies.insufficientBalance(balance, amount));
      return;
    }

    user.pendingSend = {
      amount,
      destination: resolved.destination,
      alias: resolved.alias,
      requestedAt: new Date(),
    };
    await user.save();

    const label = resolved.alias || shortenPublicKey(resolved.destination);
    await sendTextMessage(phoneNumber, replies.confirmTransfer(amount, label, resolved.destination));
  } catch (error) {
    await sendTextMessage(phoneNumber, replies.prepareError(error.message));
  }
};

const handleConfirmSend = async ({ phoneNumber, user }) => {
  if (!user.pendingSend?.destination || isPendingSendExpired(user.pendingSend)) {
    user.pendingSend = undefined;
    await user.save();
    await sendTextMessage(phoneNumber, replies.noActiveTransfer());
    return;
  }

  const wallet = await getWalletByUserId(user._id);
  if (!wallet) {
    await sendTextMessage(phoneNumber, replies.noWallet());
    return;
  }

  const { amount, destination, alias } = user.pendingSend;
  await sendTextMessage(phoneNumber, replies.processingTransfer(amount));

  const result = await executeSend({ user, wallet, destination, amount, asset: 'XLM' });

  user.pendingSend = undefined;
  await user.save();

  if (!result.ok) {
    await sendTextMessage(phoneNumber, replies.transferFailed(result.error.message));
    return;
  }

  const label = alias || shortenPublicKey(destination);
  await sendTextMessage(
    phoneNumber,
    replies.transferSuccess(amount, label, result.txHash, result.explorerUrl)
  );
};

const handleCancelSend = async ({ phoneNumber, user }) => {
  if (!user.pendingSend?.destination) {
    await sendTextMessage(phoneNumber, replies.noTransferToCancel());
    return;
  }

  user.pendingSend = undefined;
  await user.save();
  await sendTextMessage(phoneNumber, replies.transferCancelled());
};

const handleInvalidSend = async ({ phoneNumber }) => {
  await sendTextMessage(phoneNumber, replies.invalidSendFormat());
};

const handleInvalidSave = async ({ phoneNumber }) => {
  await sendTextMessage(phoneNumber, replies.invalidSaveFormat());
};

const handleUnknown = async ({ phoneNumber }) => {
  await sendTextMessage(phoneNumber, replies.unknown());
};

// Intent -> handler. New flows slot in here without touching control flow.
const handlers = {
  GREETING: handleGreeting,
  HELP: handleHelp,
  CREATE_WALLET: handleCreateWallet,
  FUND_WALLET: handleFundWallet,
  BALANCE: handleBalance,
  SAVE_CONTACT: handleSaveContact,
  LIST_CONTACTS: handleListContacts,
  SEND: handlePrepareSend,
  CONFIRM_SEND: handleConfirmSend,
  CANCEL_SEND: handleCancelSend,
  INVALID_SEND: handleInvalidSend,
  INVALID_SAVE: handleInvalidSave,
  UNKNOWN: handleUnknown,
};

const resolveRecipient = (user, recipient) => {
  const normalizedRecipient = recipient.trim();
  const publicKey = normalizedRecipient.toUpperCase();

  if (isValidPublicKey(publicKey)) {
    return { destination: publicKey, alias: null };
  }

  const alias = normalizedRecipient.toLowerCase();
  const contact = (user.contacts || []).find((item) => item.alias === alias);
  if (!contact) {
    return { destination: null, alias };
  }

  return { destination: contact.publicKey, alias: contact.alias };
};

const isPendingSendExpired = (pendingSend) => {
  if (!pendingSend.requestedAt) return true;
  return Date.now() - new Date(pendingSend.requestedAt).getTime() > PENDING_SEND_TTL_MS;
};

module.exports = {
  processMessage,
};
