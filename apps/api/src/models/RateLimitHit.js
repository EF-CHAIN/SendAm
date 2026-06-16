const mongoose = require('mongoose');

// Shared rate-limit counter. The default express-rate-limit store keeps counts
// in process memory, so on serverless / multi-instance deploys each instance
// counts independently and the real limit becomes max * instances. Persisting
// the counter here makes the window shared across every instance.
//
// One document per key (an IP for the REST limiter, or `wa:<sender>` for the
// WhatsApp throttle). `count` is the hits in the current window; `expiresAt`
// is the window end and also drives a TTL index so spent windows are reaped.
const rateLimitHitSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  count: {
    type: Number,
    default: 0,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

rateLimitHitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimitHit', rateLimitHitSchema);
