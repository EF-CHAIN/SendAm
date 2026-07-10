const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  chain: {
    type: String,
    enum: ['stellar', 'lisk'],
    required: true,
    default: 'stellar',
  },
  publicKey: {
    type: String,
    required: true,
  },
  encryptedSecretKey: {
    type: String,
    required: true,
  },
  network: {
    type: String,
    default: 'testnet',
  },
  // Whether the account has been successfully funded on-ledger (via Friendbot
  // on Testnet). Friendbot is flaky, so a wallet can exist in Mongo while its
  // account was never funded — this flag drives the create/`fund` recovery
  // path so a funding hiccup doesn't permanently strand a user.
  funded: {
    type: Boolean,
    default: false,
  },
  // Used by scripts/notify-deposits.js to detect an incoming deposit (a
  // positive delta against this value) without a dedicated chain-watcher
  // process — see that script's header for why.
  lastKnownBalance: {
    type: String,
    default: '0',
  }
}, { timestamps: true });

// One wallet per user per chain, enforced at the DB layer rather than only
// in application logic.
walletSchema.index({ userId: 1, chain: 1 }, { unique: true });

module.exports = mongoose.model('Wallet', walletSchema);
