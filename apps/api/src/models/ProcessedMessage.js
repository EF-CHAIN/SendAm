const mongoose = require('mongoose');

// Dedup record for inbound WhatsApp messages. Meta redelivers webhook events
// that aren't acknowledged in time, so without this a single "send" could be
// processed (and submitted on-ledger) more than once. The unique index makes
// the insert itself the dedup check, and the TTL index reaps old records so
// this collection doesn't grow unbounded.
const processedMessageSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    unique: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 60 * 60 * 24, // 24h
  },
});

module.exports = mongoose.model('ProcessedMessage', processedMessageSchema);
