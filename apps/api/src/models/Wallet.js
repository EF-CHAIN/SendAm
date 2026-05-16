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
  }
}, { timestamps: true });

module.exports = mongoose.model('Wallet', walletSchema);
