const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  chain: {
    type: String,
    enum: ['stellar', 'lisk'],
    default: 'stellar',
  },
  // 'send'/'receive' are wired today. The extra values reserve room for
  // on/off-ramp and swap flows so adding them needs no schema migration.
  type: {
    type: String,
    enum: ['send', 'receive', 'swap', 'onramp', 'offramp'],
    required: true,
  },
  amount: {
    type: String,
    required: true,
  },
  asset: {
    type: String,
    default: 'XLM',
  },
  destination: {
    type: String,
  },
  txHash: {
    type: String,
  },
  explorerUrl: {
    type: String,
  },
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'pending',
  }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
