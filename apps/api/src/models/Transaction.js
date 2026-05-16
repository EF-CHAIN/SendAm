const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  type: {
    type: String,
    enum: ['send', 'receive'],
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
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'pending',
  }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
