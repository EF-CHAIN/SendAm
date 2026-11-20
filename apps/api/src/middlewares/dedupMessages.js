const config = require('../config/env');
const { getRedisConnection } = require('../config/redis');

const keyFor = (id) => `sendam:whatsapp:accepted:${id}`;

// Cache only messages already accepted by the durable inbox/queue. A cache
// failure or miss falls through to the existing database idempotency check.
const createMessageDedup = (getConnection) => ({
  async has(id) {
    if (!id) return false;
    try {
      return (await getConnection()?.get(keyFor(id))) === '1';
    } catch {
      return false;
    }
  },
  async remember(id) {
    if (!id) return;
    try {
      await getConnection()?.set(keyFor(id), '1', 'NX', 'EX', 300);
    } catch {
      // Redis is an optimization. The durable claim remains authoritative.
    }
  },
});

module.exports = {
  createMessageDedup,
  acceptedMessages: createMessageDedup(() => {
    const connection = getRedisConnection(config);
    return connection?.status === 'ready' ? connection : null;
  }),
};
