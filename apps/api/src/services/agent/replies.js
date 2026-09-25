// All user-facing WhatsApp copy lives here so handlers stay focused on logic
// and message wording is easy to find, tune, and (later) localize.

const CHAIN_LABEL_STELLAR = 'Stellar';

// Named reply constants and templates
const UNKNOWN_MESSAGE = `Sorry, I didn't understand that. Reply with 'help' to see what I can do.`;
const RATE_LIMITED_MESSAGE = `You're sending messages too quickly. Please wait a moment and try again.`;

const GREETING_MESSAGE = (name) =>
  `Hello ${name || 'there'}! Welcome to SendAm. Reply with 'help' to see available commands.`;

const HELP_MESSAGE = [
  'Available commands:',
  '- create wallet: Create your Stellar wallet',
  '- fund: Retry funding your wallet if it is not yet funded',
  '- balance: Check your balance',
  '- save <name> <address>: Save a contact (Stellar address)',
  '- contacts: List saved contacts',
  '- send <amount> <asset> <address-or-name>: Prepare a transfer',
  '- yes: Confirm a pending transfer',
  '- no: Cancel a pending transfer',
  '',
  'Examples:',
  'save ada GABC...',
  'send 5 xlm ada',
].join('\n');

const GENERIC_ERROR_MESSAGE = (message) => `Sorry, an error occurred: ${message}`;

// Wallet
const CREATING_WALLET_MESSAGE = `Creating your Stellar wallet...`;
const WALLETS_READY_MESSAGE = (statusLines) => `Wallet setup complete.\n\n${statusLines}`;
const WALLETS_EXIST_MESSAGE = (statusLines) => `You already have wallets.\n\n${statusLines}`;
const NO_WALLET_MESSAGE = `You don't have a wallet yet. Send 'create wallet' first.`;
const FUNDING_WALLETS_MESSAGE = `Checking funding status...`;
const ALL_WALLETS_FUNDED_MESSAGE = (statusLines) => `All your wallets are already funded.\n\n${statusLines}`;

const WALLET_STATUS_FUNDED = (chain, publicKey) => `${chain}: funded.\n${publicKey}`;
const WALLET_STATUS_MANUAL = (chain, publicKey, instructions) =>
  `${chain}: created, not yet funded.\n${publicKey}\n${instructions}`;
const WALLET_STATUS_FAILED = (chain, publicKey) =>
  `${chain}: funding failed. Reply 'fund' to retry.\n${publicKey}`;

// Balance
const BALANCE_UNAVAILABLE_LINE = (chain, error) => `${chain}: unavailable (${error})`;
const BALANCE_UNVERIFIED_ASSET_LINE = (asset, value) =>
  `${asset}: ${value} (unverified issuer — not trusted ${asset})`;
const BALANCE_ASSET_LINE = (asset, value) => `${asset}: ${value}`;
const BALANCES_MESSAGE = (lines) => `Your balances:\n\n${lines.join('\n')}`;
const BALANCE_ERROR_MESSAGE = (message) => `Error getting balance: ${message}`;
const INSUFFICIENT_BALANCE_MESSAGE = (chain, balance, amount, asset) =>
  `Insufficient balance. You're trying to send ${amount} ${asset} but your ${chain} balance is ${balance}.`;

// Contacts
const INVALID_ADDRESS_MESSAGE = `That is not a valid Stellar address. Please check it and try again.`;
const CONTACT_SAVED_MESSAGE = (alias, chain, shortKey) =>
  `Saved ${alias} (${chain}) as ${shortKey}.\n\nYou can now send with: send 5 xlm ${alias}`;
const CONTACT_SAVE_ERROR_MESSAGE = (message) => `Could not save contact: ${message}`;
const NO_CONTACTS_MESSAGE = `You do not have saved contacts yet.\n\nUse: save <name> <address>`;
const CONTACT_LIST_ITEM = (alias, chain, shortKey) => `${alias} (${chain}): ${shortKey}`;

// Send
const INVALID_SEND_FORMAT_MESSAGE =
  `Invalid send format. Please use: send <amount> <asset> <address-or-name>\nExample: send 5 xlm GABC...`;
const INVALID_SAVE_FORMAT_MESSAGE =
  `Invalid save format. Please use: save <name> <address>\nExample: save ada GABC...`;
const RECIPIENT_NOT_FOUND_MESSAGE = (recipient) =>
  `I could not find "${recipient}" in your contacts, and it is not a valid Stellar address.\n\nUse: save ${recipient.toLowerCase()} <address>`;
const CONFIRM_TRANSFER_MESSAGE = (chain, amount, asset, label, destination) =>
  `Confirm transfer on ${chain}:\n\nAmount: ${amount} ${asset}\nTo: ${label}\nAddress: ${destination}\n\nReply YES to send or NO to cancel. This request expires in 10 minutes.`;
const PREPARE_ERROR_MESSAGE = (message) => `Could not prepare transfer: ${message}`;
const PROCESSING_TRANSFER_MESSAGE = (amount, asset) => `Processing your transfer of ${amount} ${asset}...`;
const TRANSFER_SUCCESS_MESSAGE = (amount, asset, label, txHash, explorerUrl) =>
  `Transfer successful.\n\nSent: ${amount} ${asset}\nTo: ${label}\nTransaction: ${txHash}\nReceipt: ${explorerUrl}`;
const TRANSFER_FAILED_MESSAGE = (message) => `Transfer failed: ${message}`;
const NO_ACTIVE_TRANSFER_MESSAGE = `No active transfer to confirm. Send a new command like: send 5 xlm GABC...`;
const TRANSFER_CANCELLED_MESSAGE = `Transfer cancelled.`;
const NO_TRANSFER_TO_CANCEL_MESSAGE = `No active transfer to cancel.`;

const MESSAGES = {
  UNKNOWN: UNKNOWN_MESSAGE,
  RATE_LIMITED: RATE_LIMITED_MESSAGE,
  GREETING: GREETING_MESSAGE,
  HELP: HELP_MESSAGE,
  GENERIC_ERROR: GENERIC_ERROR_MESSAGE,

  // Wallet
  CREATING_WALLET: CREATING_WALLET_MESSAGE,
  WALLETS_READY: WALLETS_READY_MESSAGE,
  WALLETS_EXIST: WALLETS_EXIST_MESSAGE,
  NO_WALLET: NO_WALLET_MESSAGE,
  FUNDING_WALLETS: FUNDING_WALLETS_MESSAGE,
  ALL_WALLETS_FUNDED: ALL_WALLETS_FUNDED_MESSAGE,
  WALLET_STATUS_FUNDED,
  WALLET_STATUS_MANUAL,
  WALLET_STATUS_FAILED,

  // Balance
  BALANCES: BALANCES_MESSAGE,
  BALANCE_UNAVAILABLE: BALANCE_UNAVAILABLE_LINE,
  BALANCE_UNVERIFIED_ASSET: BALANCE_UNVERIFIED_ASSET_LINE,
  BALANCE_ASSET: BALANCE_ASSET_LINE,
  BALANCE_ERROR: BALANCE_ERROR_MESSAGE,
  INSUFFICIENT_BALANCE: INSUFFICIENT_BALANCE_MESSAGE,

  // Contacts
  INVALID_ADDRESS: INVALID_ADDRESS_MESSAGE,
  CONTACT_SAVED: CONTACT_SAVED_MESSAGE,
  CONTACT_SAVE_ERROR: CONTACT_SAVE_ERROR_MESSAGE,
  NO_CONTACTS: NO_CONTACTS_MESSAGE,
  CONTACT_LIST_ITEM,

  // Send
  INVALID_SEND_FORMAT: INVALID_SEND_FORMAT_MESSAGE,
  INVALID_SAVE_FORMAT: INVALID_SAVE_FORMAT_MESSAGE,
  RECIPIENT_NOT_FOUND: RECIPIENT_NOT_FOUND_MESSAGE,
  CONFIRM_TRANSFER: CONFIRM_TRANSFER_MESSAGE,
  PREPARE_ERROR: PREPARE_ERROR_MESSAGE,
  PROCESSING_TRANSFER: PROCESSING_TRANSFER_MESSAGE,
  TRANSFER_SUCCESS: TRANSFER_SUCCESS_MESSAGE,
  TRANSFER_FAILED: TRANSFER_FAILED_MESSAGE,
  NO_ACTIVE_TRANSFER: NO_ACTIVE_TRANSFER_MESSAGE,
  TRANSFER_CANCELLED: TRANSFER_CANCELLED_MESSAGE,
  NO_TRANSFER_TO_CANCEL: NO_TRANSFER_TO_CANCEL_MESSAGE,
};

const shortenPublicKey = (publicKey) => `${publicKey.substring(0, 8)}...${publicKey.slice(-4)}`;

const chainLabel = () => CHAIN_LABEL_STELLAR;

// One line per wallet, used by both the create-wallet and fund flows since
// they report the same shape: { chain, publicKey, funded, manual?, instructions? }.
const walletStatusLines = (wallets) =>
  wallets
    .map((w) => {
      if (w.funded) {
        return WALLET_STATUS_FUNDED(chainLabel(w.chain), w.publicKey);
      }
      if (w.manual) {
        return WALLET_STATUS_MANUAL(chainLabel(w.chain), w.publicKey, w.instructions);
      }
      return WALLET_STATUS_FAILED(chainLabel(w.chain), w.publicKey);
    })
    .join('\n\n');

const replies = {
  greeting: (name) => GREETING_MESSAGE(name),
  help: () => HELP_MESSAGE,
  unknown: () => UNKNOWN_MESSAGE,
  genericError: (message) => GENERIC_ERROR_MESSAGE(message),
  rateLimited: () => RATE_LIMITED_MESSAGE,

  // Wallet
  creatingWallet: () => CREATING_WALLET_MESSAGE,
  walletsReady: (wallets) => WALLETS_READY_MESSAGE(walletStatusLines(wallets)),
  walletsExist: (wallets) => WALLETS_EXIST_MESSAGE(walletStatusLines(wallets)),
  noWallet: () => NO_WALLET_MESSAGE,
  fundingWallets: () => FUNDING_WALLETS_MESSAGE,
  allWalletsFunded: (wallets) => ALL_WALLETS_FUNDED_MESSAGE(walletStatusLines(wallets)),

  // Balance — one line per asset across all wallets.
  // A wallet with no USDC trustline shows only XLM.
  // A wallet whose Horizon fetch failed shows a single error line instead of
  // asset rows so the rest of the reply is still rendered.
  // An asset row whose issuer this service doesn't recognise (`trusted:
  // false`, e.g. a same-code token from an unverified issuer) is flagged
  // rather than shown as if it were the real, trusted asset (#285).
  balances: (wallets) => {
    const lines = wallets.flatMap((w) => {
      if (w.error) {
        return [BALANCE_UNAVAILABLE_LINE(chainLabel(w.chain), w.error)];
      }
      return (w.assets || []).map((a) => (
        a.trusted === false
          ? BALANCE_UNVERIFIED_ASSET_LINE(a.asset, a.value)
          : BALANCE_ASSET_LINE(a.asset, a.value)
      ));
    });
    return BALANCES_MESSAGE(lines);
  },
  balanceError: (message) => BALANCE_ERROR_MESSAGE(message),
  insufficientBalance: (chain, balance, amount, asset) =>
    INSUFFICIENT_BALANCE_MESSAGE(chainLabel(chain), balance, amount, asset),

  // Contacts
  invalidAddress: () => INVALID_ADDRESS_MESSAGE,
  contactSaved: (alias, publicKey, chain) =>
    CONTACT_SAVED_MESSAGE(alias, chainLabel(chain), shortenPublicKey(publicKey)),
  contactSaveError: (message) => CONTACT_SAVE_ERROR_MESSAGE(message),
  noContacts: () => NO_CONTACTS_MESSAGE,
  contactList: (contacts) =>
    contacts
      .map((c) => CONTACT_LIST_ITEM(c.alias, chainLabel(c.chain), shortenPublicKey(c.publicKey)))
      .join('\n'),

  // Send
  invalidSendFormat: () => INVALID_SEND_FORMAT_MESSAGE,
  invalidSaveFormat: () => INVALID_SAVE_FORMAT_MESSAGE,
  recipientNotFound: (recipient) => RECIPIENT_NOT_FOUND_MESSAGE(recipient),
  confirmTransfer: (amount, asset, label, destination, chain) =>
    CONFIRM_TRANSFER_MESSAGE(chainLabel(chain), amount, asset, label, destination),
  prepareError: (message) => PREPARE_ERROR_MESSAGE(message),
  processingTransfer: (amount, asset) => PROCESSING_TRANSFER_MESSAGE(amount, asset),
  transferSuccess: (amount, asset, label, txHash, explorerUrl) =>
    TRANSFER_SUCCESS_MESSAGE(amount, asset, label, txHash, explorerUrl),
  transferFailed: (message) => TRANSFER_FAILED_MESSAGE(message),
  noActiveTransfer: () => NO_ACTIVE_TRANSFER_MESSAGE,
  transferCancelled: () => TRANSFER_CANCELLED_MESSAGE,
  noTransferToCancel: () => NO_TRANSFER_TO_CANCEL_MESSAGE,
};

module.exports = {
  replies,
  shortenPublicKey,
  chainLabel,
  MESSAGES,
  CHAIN_LABEL_STELLAR,
  UNKNOWN_MESSAGE,
  RATE_LIMITED_MESSAGE,
  GREETING_MESSAGE,
  HELP_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  CREATING_WALLET_MESSAGE,
  WALLETS_READY_MESSAGE,
  WALLETS_EXIST_MESSAGE,
  NO_WALLET_MESSAGE,
  FUNDING_WALLETS_MESSAGE,
  ALL_WALLETS_FUNDED_MESSAGE,
  WALLET_STATUS_FUNDED,
  WALLET_STATUS_MANUAL,
  WALLET_STATUS_FAILED,
  BALANCE_UNAVAILABLE_LINE,
  BALANCE_UNVERIFIED_ASSET_LINE,
  BALANCE_ASSET_LINE,
  BALANCES_MESSAGE,
  BALANCE_ERROR_MESSAGE,
  INSUFFICIENT_BALANCE_MESSAGE,
  INVALID_ADDRESS_MESSAGE,
  CONTACT_SAVED_MESSAGE,
  CONTACT_SAVE_ERROR_MESSAGE,
  NO_CONTACTS_MESSAGE,
  CONTACT_LIST_ITEM,
  INVALID_SEND_FORMAT_MESSAGE,
  INVALID_SAVE_FORMAT_MESSAGE,
  RECIPIENT_NOT_FOUND_MESSAGE,
  CONFIRM_TRANSFER_MESSAGE,
  PREPARE_ERROR_MESSAGE,
  PROCESSING_TRANSFER_MESSAGE,
  TRANSFER_SUCCESS_MESSAGE,
  TRANSFER_FAILED_MESSAGE,
  NO_ACTIVE_TRANSFER_MESSAGE,
  TRANSFER_CANCELLED_MESSAGE,
  NO_TRANSFER_TO_CANCEL_MESSAGE,
};
