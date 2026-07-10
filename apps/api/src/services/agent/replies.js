// All user-facing WhatsApp copy lives here so handlers stay focused on logic
// and message wording is easy to find, tune, and (later) localize.

const shortenPublicKey = (publicKey) => `${publicKey.substring(0, 8)}...${publicKey.slice(-4)}`;

const chainLabel = (chain) => (chain === 'lisk' ? 'Lisk' : 'Stellar');

// One line per wallet, used by both the create-wallet and fund flows since
// they report the same shape: { chain, publicKey, funded, manual?, instructions? }.
const walletStatusLines = (wallets) =>
  wallets
    .map((w) => {
      if (w.funded) {
        return `${chainLabel(w.chain)}: funded.\n${w.publicKey}`;
      }
      if (w.manual) {
        return `${chainLabel(w.chain)}: created, not yet funded.\n${w.publicKey}\n${w.instructions}`;
      }
      return `${chainLabel(w.chain)}: funding failed. Reply 'fund' to retry.\n${w.publicKey}`;
    })
    .join('\n\n');

const replies = {
  greeting: (name) =>
    `Hello ${name || 'there'}! Welcome to SendAm. Reply with 'help' to see available commands.`,

  help: () =>
    [
      'Available commands:',
      '- create wallet: Create your Stellar and Lisk wallets',
      '- fund: Retry funding any wallet that is not yet funded',
      '- balance: Check your balances across chains',
      '- save <name> <address>: Save a contact (Stellar or Lisk address)',
      '- contacts: List saved contacts',
      '- send <amount> <asset> <address-or-name>: Prepare a transfer',
      '- yes: Confirm a pending transfer',
      '- no: Cancel a pending transfer',
      '',
      'Examples:',
      'save ada GABC...',
      'send 5 xlm ada',
      'send 0.01 eth 0x1234...',
    ].join('\n'),

  unknown: () => `Sorry, I didn't understand that. Reply with 'help' to see what I can do.`,
  genericError: (message) => `Sorry, an error occurred: ${message}`,
  rateLimited: () => `You're sending messages too quickly. Please wait a moment and try again.`,

  // Wallet
  creatingWallet: () => `Creating your Stellar and Lisk wallets...`,
  walletsReady: (wallets) => `Wallet setup complete.\n\n${walletStatusLines(wallets)}`,
  walletsExist: (wallets) => `You already have wallets.\n\n${walletStatusLines(wallets)}`,
  noWallet: () => `You don't have a wallet yet. Send 'create wallet' first.`,
  fundingWallets: () => `Checking funding status...`,
  allWalletsFunded: (wallets) => `All your wallets are already funded.\n\n${walletStatusLines(wallets)}`,

  // Balance
  balances: (wallets) =>
    `Your balances:\n\n${wallets.map((w) => `${chainLabel(w.chain)}: ${w.balance}${w.error ? ` (${w.error})` : ''}`).join('\n')}`,
  balanceError: (message) => `Error getting balance: ${message}`,
  insufficientBalance: (chain, balance, amount, asset) =>
    `Insufficient balance. You're trying to send ${amount} ${asset} but your ${chainLabel(chain)} balance is ${balance}.`,

  // Contacts
  invalidAddress: () =>
    `That is not a valid Stellar or Lisk address. Please check it and try again.`,
  contactSaved: (alias, publicKey, chain) =>
    `Saved ${alias} (${chainLabel(chain)}) as ${shortenPublicKey(publicKey)}.\n\nYou can now send with: send 5 ${chain === 'lisk' ? 'eth' : 'xlm'} ${alias}`,
  contactSaveError: (message) => `Could not save contact: ${message}`,
  noContacts: () => `You do not have saved contacts yet.\n\nUse: save <name> <address>`,
  contactList: (contacts) =>
    contacts.map((c) => `${c.alias} (${chainLabel(c.chain)}): ${shortenPublicKey(c.publicKey)}`).join('\n'),

  // Send
  invalidSendFormat: () =>
    `Invalid send format. Please use: send <amount> <asset> <address-or-name>\nExample: send 5 xlm GABC... or send 0.01 eth 0x...`,
  invalidSaveFormat: () =>
    `Invalid save format. Please use: save <name> <address>\nExample: save ada GABC...`,
  recipientNotFound: (recipient) =>
    `I could not find "${recipient}" in your contacts, and it is not a valid Stellar or Lisk address.\n\nUse: save ${recipient.toLowerCase()} <address>`,
  confirmTransfer: (amount, asset, label, destination, chain) =>
    `Confirm transfer on ${chainLabel(chain)}:\n\nAmount: ${amount} ${asset}\nTo: ${label}\nAddress: ${destination}\n\nReply YES to send or NO to cancel. This request expires in 10 minutes.`,
  prepareError: (message) => `Could not prepare transfer: ${message}`,
  processingTransfer: (amount, asset) => `Processing your transfer of ${amount} ${asset}...`,
  transferSuccess: (amount, asset, label, txHash, explorerUrl) =>
    `Transfer successful.\n\nSent: ${amount} ${asset}\nTo: ${label}\nTransaction: ${txHash}\nReceipt: ${explorerUrl}`,
  transferFailed: (message) => `Transfer failed: ${message}`,
  noActiveTransfer: () => `No active transfer to confirm. Send a new command like: send 5 xlm GABC...`,
  transferCancelled: () => `Transfer cancelled.`,
  noTransferToCancel: () => `No active transfer to cancel.`,
};

module.exports = {
  replies,
  shortenPublicKey,
  chainLabel,
};
