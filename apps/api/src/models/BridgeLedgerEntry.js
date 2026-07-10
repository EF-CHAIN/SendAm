const mongoose = require('mongoose');

// Audit trail for the Phase 2 bridge groundwork spike (see
// scripts/bridge-spike.js). This is testnet-only bookkeeping for a mechanism
// that is NOT wired into the live bot — not a production settlement ledger.
const bridgeLedgerEntrySchema = new mongoose.Schema({
  fromChain: {
    type: String,
    enum: ['stellar', 'lisk'],
    required: true,
  },
  toChain: {
    type: String,
    enum: ['stellar', 'lisk'],
    required: true,
  },
  sourceAddress: {
    type: String,
    required: true,
  },
  destinationAddress: {
    type: String,
    required: true,
  },
  amountIn: {
    type: String,
    required: true,
  },
  amountOut: {
    type: String,
  },
  sourceTxHash: {
    type: String,
  },
  destinationTxHash: {
    type: String,
  },
  status: {
    type: String,
    enum: ['observed', 'settling', 'settled', 'failed'],
    default: 'observed',
  },
  notes: {
    type: String,
  },
}, { timestamps: true });

module.exports = mongoose.model('BridgeLedgerEntry', bridgeLedgerEntrySchema);
