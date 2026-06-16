const { consume, decrement, resetKey } = require('../services/rateLimit.service');

// express-rate-limit v7 Store backed by Mongo (see rateLimit.service). Plugging
// this into the limiter replaces the default in-memory store so the window is
// shared across instances.
class MongoRateStore {
  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    return consume(key, this.windowMs);
  }

  async decrement(key) {
    return decrement(key);
  }

  async resetKey(key) {
    return resetKey(key);
  }
}

module.exports = MongoRateStore;
