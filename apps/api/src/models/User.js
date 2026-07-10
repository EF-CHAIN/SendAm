const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true,
  },
  whatsappName: {
    type: String,
  },
  // Wallets are looked up from the Wallet collection (one per user per
  // chain) rather than referenced here — a single ref can't represent more
  // than one chain, and keeping Wallet as the sole source of truth avoids a
  // second place that can drift out of sync.
  contacts: [{
    alias: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    publicKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    chain: {
      type: String,
      enum: ['stellar', 'lisk'],
      default: 'stellar',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],
  pendingSend: {
    amount: String,
    asset: String,
    destination: String,
    alias: String,
    chain: String,
    requestedAt: Date,
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
