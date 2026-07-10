const { parseIntent } = require('./intents');
const { replies, shortenPublicKey } = require('./replies');
const { sendTextMessage } = require('../whatsapp.service');
const {
  createWalletForUser,
  getWalletsByUserId,
  getWalletByUserIdAndChain,
  markWalletFunded,
} = require('../wallet.service');
const { resolveAdapter, detectChainFromAddress, SUPPORTED_CHAINS } = require('../chains');
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

const toWalletStatus = (wallet) => ({ chain: wallet.chain, publicKey: wallet.publicKey, funded: wallet.funded });

// Attempt to (re)fund one wallet and return its resulting status. Stellar
// auto-funds via Friendbot (retried inside the adapter). Lisk has no
// equivalent auto-fund API — see lisk.adapter.js — so instead we check
// whether the account already holds a balance (the user funded it manually)
// and otherwise return manual instructions rather than pretending funding
// was attempted.
const attemptFundWallet = async (wallet) => {
  const adapter = resolveAdapter(wallet.chain);

  if (wallet.chain === 'stellar') {
    await adapter.fundTestnetAccount(wallet.publicKey);
    await markWalletFunded(wallet._id);
    return { chain: wallet.chain, publicKey: wallet.publicKey, funded: true };
  }

  const balance = await adapter.getBalance(wallet.publicKey).catch(() => '0');
  if (Number(balance) > 0) {
    await markWalletFunded(wallet._id);
    return { chain: wallet.chain, publicKey: wallet.publicKey, funded: true };
  }

  const { instructions } = await adapter.fundTestnetAccount(wallet.publicKey);
  return { chain: wallet.chain, publicKey: wallet.publicKey, funded: false, manual: true, instructions };
};

const handleGreeting = async ({ phoneNumber, whatsappName }) => {
  await sendTextMessage(phoneNumber, replies.greeting(whatsappName));
};

const handleHelp = async ({ phoneNumber }) => {
  await sendTextMessage(phoneNumber, replies.help());
};

const handleCreateWallet = async ({ phoneNumber, user }) => {
  const existingWallets = await getWalletsByUserId(user._id);
  const walletsByChain = Object.fromEntries(existingWallets.map((w) => [w.chain, w]));

  const allFunded = SUPPORTED_CHAINS.every((chain) => walletsByChain[chain]?.funded);
  if (allFunded) {
    await sendTextMessage(phoneNumber, replies.walletsExist(existingWallets.map(toWalletStatus)));
    return;
  }

  await sendTextMessage(phoneNumber, replies.creatingWallet());

  const results = [];
  for (const chain of SUPPORTED_CHAINS) {
    let wallet = walletsByChain[chain];
    if (!wallet) {
      wallet = await createWalletForUser(user._id, chain);
    }
    if (wallet.funded) {
      results.push(toWalletStatus(wallet));
      continue;
    }
    try {
      results.push(await attemptFundWallet(wallet));
    } catch (error) {
      logger.error(`Funding failed for ${wallet.publicKey} (${chain}):`, error.message);
      results.push({ chain, publicKey: wallet.publicKey, funded: false });
    }
  }

  await sendTextMessage(phoneNumber, replies.walletsReady(results));
};

const handleFundWallet = async ({ phoneNumber, user }) => {
  const wallets = await getWalletsByUserId(user._id);
  if (wallets.length === 0) {
    await sendTextMessage(phoneNumber, replies.noWallet());
    return;
  }

  const unfunded = wallets.filter((w) => !w.funded);
  if (unfunded.length === 0) {
    await sendTextMessage(phoneNumber, replies.allWalletsFunded(wallets.map(toWalletStatus)));
    return;
  }

  await sendTextMessage(phoneNumber, replies.fundingWallets());

  const results = [];
  for (const wallet of wallets) {
    if (wallet.funded) {
      results.push(toWalletStatus(wallet));
      continue;
    }
    try {
      results.push(await attemptFundWallet(wallet));
    } catch (error) {
      logger.error(`Funding failed for ${wallet.publicKey} (${wallet.chain}):`, error.message);
      results.push({ chain: wallet.chain, publicKey: wallet.publicKey, funded: false });
    }
  }

  await sendTextMessage(phoneNumber, replies.walletsReady(results));
};

const handleBalance = async ({ phoneNumber, user }) => {
  const wallets = await getWalletsByUserId(user._id);
  if (wallets.length === 0) {
    await sendTextMessage(phoneNumber, replies.noWallet());
    return;
  }

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const balance = await resolveAdapter(wallet.chain).getBalance(wallet.publicKey);
        return { chain: wallet.chain, balance };
      } catch (error) {
        return { chain: wallet.chain, balance: '0', error: error.message };
      }
    })
  );

  await sendTextMessage(phoneNumber, replies.balances(results));
};

const handleSaveContact = async ({ phoneNumber, user, payload }) => {
  try {
    const { alias, publicKey } = payload;
    const chain = detectChainFromAddress(publicKey);
    if (!chain) {
      await sendTextMessage(phoneNumber, replies.invalidAddress());
      return;
    }

    // Stellar keys are conventionally stored uppercase (StrKey); EVM
    // addresses are left as typed since case carries checksum meaning.
    const normalizedPublicKey = chain === 'stellar' ? publicKey.toUpperCase() : publicKey;

    user.contacts = (user.contacts || []).filter((contact) => contact.alias !== alias);
    user.contacts.push({ alias, publicKey: normalizedPublicKey, chain });
    await user.save();

    await sendTextMessage(phoneNumber, replies.contactSaved(alias, normalizedPublicKey, chain));
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
    const { amount, asset, recipient } = payload;
    const resolved = resolveRecipient(user, recipient);

    if (!resolved.destination) {
      await sendTextMessage(phoneNumber, replies.recipientNotFound(recipient));
      return;
    }

    const wallet = await getWalletByUserIdAndChain(user._id, resolved.chain);
    if (!wallet) {
      await sendTextMessage(phoneNumber, replies.noWallet());
      return;
    }

    // Pre-flight balance check: catch "sending more than you have" before the
    // user confirms, instead of letting it fail on-ledger after they reply YES.
    const balance = await resolveAdapter(resolved.chain).getBalance(wallet.publicKey);
    if (Number(balance) < Number(amount)) {
      await sendTextMessage(phoneNumber, replies.insufficientBalance(resolved.chain, balance, amount, asset));
      return;
    }

    user.pendingSend = {
      amount,
      asset,
      destination: resolved.destination,
      alias: resolved.alias,
      chain: resolved.chain,
      requestedAt: new Date(),
    };
    await user.save();

    const label = resolved.alias || shortenPublicKey(resolved.destination);
    await sendTextMessage(phoneNumber, replies.confirmTransfer(amount, asset, label, resolved.destination, resolved.chain));
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

  const { amount, asset, destination, alias, chain } = user.pendingSend;

  const wallet = await getWalletByUserIdAndChain(user._id, chain);
  if (!wallet) {
    await sendTextMessage(phoneNumber, replies.noWallet());
    return;
  }

  await sendTextMessage(phoneNumber, replies.processingTransfer(amount, asset));

  const result = await executeSend({ user, wallet, destination, amount, asset });

  user.pendingSend = undefined;
  await user.save();

  if (!result.ok) {
    await sendTextMessage(phoneNumber, replies.transferFailed(result.error.message));
    return;
  }

  const label = alias || shortenPublicKey(destination);
  await sendTextMessage(
    phoneNumber,
    replies.transferSuccess(amount, asset, label, result.txHash, result.explorerUrl)
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

// Detects the destination chain from the raw address shape before falling
// back to a saved alias — a chain-qualified address always wins over a
// same-named alias, and an alias carries its own stored chain so the caller
// never has to guess which wallet to check.
const resolveRecipient = (user, recipient) => {
  const normalizedRecipient = recipient.trim();
  const chain = detectChainFromAddress(normalizedRecipient);

  if (chain) {
    const destination = chain === 'stellar' ? normalizedRecipient.toUpperCase() : normalizedRecipient;
    return { destination, alias: null, chain };
  }

  const alias = normalizedRecipient.toLowerCase();
  const contact = (user.contacts || []).find((item) => item.alias === alias);
  if (!contact) {
    return { destination: null, alias, chain: null };
  }

  return { destination: contact.publicKey, alias: contact.alias, chain: contact.chain || 'stellar' };
};

const isPendingSendExpired = (pendingSend) => {
  if (!pendingSend.requestedAt) return true;
  return Date.now() - new Date(pendingSend.requestedAt).getTime() > PENDING_SEND_TTL_MS;
};

module.exports = {
  processMessage,
  resolveRecipient,
  isPendingSendExpired,
};
