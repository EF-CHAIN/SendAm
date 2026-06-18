const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
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
  }
}, { timestamps: true });

module.exports = mongoose.model('Wallet', walletSchema);
