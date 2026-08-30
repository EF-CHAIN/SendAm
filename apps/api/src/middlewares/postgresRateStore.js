const { consume, decrement, resetKey } = require('../services/rateLimit.service');

// express-rate-limit v7 Store backed by PostgreSQL. This keeps counters shared
// across API instances and aligns with the Neon database architecture.
class PostgresRateStore {
  constructor(prefix = '') {
    this.prefix = prefix;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    return consume(`${this.prefix}${key}`, this.windowMs);
  }

  async decrement(key) {
    return decrement(`${this.prefix}${key}`);
  }

  async resetKey(key) {
    return resetKey(`${this.prefix}${key}`);
  }
}

module.exports = PostgresRateStore;
