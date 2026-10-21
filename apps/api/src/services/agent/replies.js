// All user-facing WhatsApp copy lives here so handlers stay focused on logic
// and message wording is easy to find, tune, and (later) localize.

const shortenPublicKey = (publicKey) => `${publicKey.substring(0, 8)}...${publicKey.slice(-4)}`;

const chainLabel = () => 'Stellar';

// ── Static and Template String Constants ─────────────────────────────────────
const STRINGS = {
  UNKNOWN: `Sorry, I didn't understand that. Reply with 'help' to see what I can do.`,
  RATE_LIMITED: `You're sending messages too quickly. Please wait a moment and try again.`,
  CREATING_WALLET: `Creating your Stellar wallet...`,
  NO_WALLET: `You don't have a wallet yet. Send 'create wallet' first.`,
  FUNDING_WALLETS: `Checking funding status...`,
  INVALID_ADDRESS: `That is not a valid Stellar address. Please check it and try again.`,
  NO_CONTACTS: `You do not have saved contacts yet.\n\nUse: save <name> <address>`,
  INVALID_SEND_FORMAT: `Invalid send format. Please use: send <amount> <asset> <address-or-name>\nExample: send 5 xlm GABC...`,
  INVALID_SAVE_FORMAT: `Invalid save format. Please use: save <name> <address>\nExample: save ada GABC...`,
  NO_ACTIVE_TRANSFER: `No active transfer to confirm. Send a new command like: send 5 xlm GABC...`,
  TRANSFER_CANCELLED: `Transfer cancelled.`,
  NO_TRANSFER_TO_CANCEL: `No active transfer to cancel.`,
  HELP: [
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
  ].join('\n'),
};

const TEMPLATES = {
  GREETING: (name) =>
    `Hello ${name || 'there'}! Welcome to SendAm. Reply with 'help' to see available commands.`,
  GENERIC_ERROR: (message) => `Sorry, an error occurred: ${message}`,
  WALLETS_READY: (statusLines) => `Wallet setup complete.\n\n${statusLines}`,
  WALLETS_EXIST: (statusLines) => `You already have wallets.\n\n${statusLines}`,
  ALL_WALLETS_FUNDED: (statusLines) => `All your wallets are already funded.\n\n${statusLines}`,
  BALANCES: (lines) => `Your balances:\n\n${lines}`,
  BALANCE_ERROR: (message) => `Error getting balance: ${message}`,
  INSUFFICIENT_BALANCE: (chain, balance, amount, asset) =>
    `Insufficient balance. You're trying to send ${amount} ${asset} but your ${chainLabel(chain)} balance is ${balance}.`,
  CONTACT_SAVED: (alias, chain, shortKey) =>
    `Saved ${alias} (${chainLabel(chain)}) as ${shortKey}.\n\nYou can now send with: send 5 xlm ${alias}`,
  CONTACT_SAVE_ERROR: (message) => `Could not save contact: ${message}`,
  RECIPIENT_NOT_FOUND: (recipient) =>
    `I could not find "${recipient}" in your contacts, and it is not a valid Stellar address.\n\nUse: save ${recipient.toLowerCase()} <address>`,
  CONFIRM_TRANSFER: (chain, amount, asset, label, destination) =>
    `Confirm transfer on ${chainLabel(chain)}:\n\nAmount: ${amount} ${asset}\nTo: ${label}\nAddress: ${destination}\n\nReply YES to send or NO to cancel. This request expires in 10 minutes.`,
  PREPARE_ERROR: (message) => `Could not prepare transfer: ${message}`,
  PROCESSING_TRANSFER: (amount, asset) => `Processing your transfer of ${amount} ${asset}...`,
  TRANSFER_SUCCESS: (amount, asset, label, txHash, explorerUrl) =>
    `Transfer successful.\n\nSent: ${amount} ${asset}\nTo: ${label}\nTransaction: ${txHash}\nReceipt: ${explorerUrl}`,
  TRANSFER_FAILED: (message) => `Transfer failed: ${message}`,
  WALLET_FUNDED_LINE: (chain, publicKey) => `${chainLabel(chain)}: funded.\n${publicKey}`,
  WALLET_MANUAL_LINE: (chain, publicKey, instructions) => `${chainLabel(chain)}: created, not yet funded.\n${publicKey}\n${instructions}`,
  WALLET_FAILED_LINE: (chain, publicKey) => `${chainLabel(chain)}: funding failed. Reply 'fund' to retry.\n${publicKey}`,
  BALANCE_UNAVAILABLE_LINE: (chain, error) => `${chainLabel(chain)}: unavailable (${error})`,
  BALANCE_UNVERIFIED_LINE: (asset, value) => `${asset}: ${value} (unverified issuer — not trusted ${asset})`,
  BALANCE_ASSET_LINE: (asset, value) => `${asset}: ${value}`,
  CONTACT_ENTRY_LINE: (alias, chain, shortKey) => `${alias} (${chainLabel(chain)}): ${shortKey}`,
};

// One line per wallet, used by both the create-wallet and fund flows since
// they report the same shape: { chain, publicKey, funded, manual?, instructions? }.
const walletStatusLines = (wallets) =>
  wallets
    .map((w) => {
      if (w.funded) {
        return TEMPLATES.WALLET_FUNDED_LINE(w.chain, w.publicKey);
      }
      if (w.manual) {
        return TEMPLATES.WALLET_MANUAL_LINE(w.chain, w.publicKey, w.instructions);
      }
      return TEMPLATES.WALLET_FAILED_LINE(w.chain, w.publicKey);
    })
    .join('\n\n');

const replies = {
  greeting: (name) => TEMPLATES.GREETING(name),

  help: () => STRINGS.HELP,

  unknown: () => STRINGS.UNKNOWN,
  genericError: (message) => TEMPLATES.GENERIC_ERROR(message),
  rateLimited: () => STRINGS.RATE_LIMITED,

  // Wallet
  creatingWallet: () => STRINGS.CREATING_WALLET,
  walletsReady: (wallets) => TEMPLATES.WALLETS_READY(walletStatusLines(wallets)),
  walletsExist: (wallets) => TEMPLATES.WALLETS_EXIST(walletStatusLines(wallets)),
  noWallet: () => STRINGS.NO_WALLET,
  fundingWallets: () => STRINGS.FUNDING_WALLETS,
  allWalletsFunded: (wallets) => TEMPLATES.ALL_WALLETS_FUNDED(walletStatusLines(wallets)),

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
        return [TEMPLATES.BALANCE_UNAVAILABLE_LINE(w.chain, w.error)];
      }
      return (w.assets || []).map((a) => (
        a.trusted === false
          ? TEMPLATES.BALANCE_UNVERIFIED_LINE(a.asset, a.value)
          : TEMPLATES.BALANCE_ASSET_LINE(a.asset, a.value)
      ));
    });
    return TEMPLATES.BALANCES(lines.join('\n'));
  },
  balanceError: (message) => TEMPLATES.BALANCE_ERROR(message),
  insufficientBalance: (chain, balance, amount, asset) =>
    TEMPLATES.INSUFFICIENT_BALANCE(chain, balance, amount, asset),

  // Contacts
  invalidAddress: () => STRINGS.INVALID_ADDRESS,
  contactSaved: (alias, publicKey, chain) =>
    TEMPLATES.CONTACT_SAVED(alias, chain, shortenPublicKey(publicKey)),
  contactSaveError: (message) => TEMPLATES.CONTACT_SAVE_ERROR(message),
  noContacts: () => STRINGS.NO_CONTACTS,
  contactList: (contacts) =>
    contacts.map((c) => TEMPLATES.CONTACT_ENTRY_LINE(c.alias, c.chain, shortenPublicKey(c.publicKey))).join('\n'),

  // Send
  invalidSendFormat: () => STRINGS.INVALID_SEND_FORMAT,
  invalidSaveFormat: () => STRINGS.INVALID_SAVE_FORMAT,
  recipientNotFound: (recipient) => TEMPLATES.RECIPIENT_NOT_FOUND(recipient),
  confirmTransfer: (amount, asset, label, destination, chain) =>
    TEMPLATES.CONFIRM_TRANSFER(chain, amount, asset, label, destination),
  prepareError: (message) => TEMPLATES.PREPARE_ERROR(message),
  processingTransfer: (amount, asset) => TEMPLATES.PROCESSING_TRANSFER(amount, asset),
  transferSuccess: (amount, asset, label, txHash, explorerUrl) =>
    TEMPLATES.TRANSFER_SUCCESS(amount, asset, label, txHash, explorerUrl),
  transferFailed: (message) => TEMPLATES.TRANSFER_FAILED(message),
  noActiveTransfer: () => STRINGS.NO_ACTIVE_TRANSFER,
  transferCancelled: () => STRINGS.TRANSFER_CANCELLED,
  noTransferToCancel: () => STRINGS.NO_TRANSFER_TO_CANCEL,
};

module.exports = {
  STRINGS,
  TEMPLATES,
  replies,
  shortenPublicKey,
  chainLabel,
};
