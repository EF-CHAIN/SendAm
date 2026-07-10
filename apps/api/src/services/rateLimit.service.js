const prisma = require('../common/prisma');

/**
 * Fixed-window counter backed by PostgreSQL and shared across instances. Used both
 * by the express-rate-limit store (REST) and the WhatsApp per-sender throttle.
 *
 * Returns { totalHits, resetTime } for the current window. Window handling has
 * a small boundary race (two requests can both start a fresh window), which is
 * acceptable for rate limiting and far better than the per-process default.
 */
const consume = async (key, windowMs) => {
  const now = Date.now();

  const liveWindow = await prisma.rateLimitHit.findUnique({ where: { key } });
  if (liveWindow && liveWindow.resetAt > new Date(now)) {
    const existing = await prisma.rateLimitHit.update({
      where: { key },
      data: { count: { increment: 1 } },
    });
    return { totalHits: existing.count, resetTime: existing.resetAt };
  }

  const resetTime = new Date(now + windowMs);

  const fresh = await prisma.rateLimitHit.upsert({
    where: { key },
    update: { count: 1, resetAt: resetTime },
    create: { key, count: 1, resetAt: resetTime },
  });

  return { totalHits: fresh.count, resetTime: fresh.resetAt };
};

const decrement = async (key) => {
  const current = await prisma.rateLimitHit.findUnique({ where: { key } });
  if (!current || current.resetAt <= new Date() || current.count <= 0) return;
  await prisma.rateLimitHit.update({
    where: { key },
    data: { count: { decrement: 1 } },
  });
};

const resetKey = async (key) => {
  await prisma.rateLimitHit.delete({ where: { key } }).catch(() => null);
};

module.exports = {
  consume,
  decrement,
  resetKey,
};
