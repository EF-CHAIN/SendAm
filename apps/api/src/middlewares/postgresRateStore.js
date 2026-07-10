const { consume, decrement, resetKey } = require('../services/rateLimit.service');

// express-rate-limit v7 Store backed by PostgreSQL. This keeps counters shared
// across API instances and aligns with the Neon database architecture.
class PostgresRateStore {
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

module.exports = PostgresRateStore;
