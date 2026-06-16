const RateLimitHit = require('../models/RateLimitHit');

/**
 * Fixed-window counter backed by Mongo and shared across instances. Used both
 * by the express-rate-limit store (REST) and the WhatsApp per-sender throttle.
 *
 * Returns { totalHits, resetTime } for the current window. Window handling has
 * a small boundary race (two requests can both start a fresh window), which is
 * acceptable for rate limiting and far better than the per-process default.
 */
const consume = async (key, windowMs) => {
  const now = Date.now();

  // Count this hit against the live window if one exists.
  const existing = await RateLimitHit.findOneAndUpdate(
    { key, expiresAt: { $gt: new Date(now) } },
    { $inc: { count: 1 } },
    { new: true }
  );
  if (existing) {
    return { totalHits: existing.count, resetTime: existing.expiresAt };
  }

  // No live window (new key or the previous window expired): open a fresh one.
  const resetTime = new Date(now + windowMs);
  try {
    const fresh = await RateLimitHit.findOneAndUpdate(
      { key },
      { $set: { count: 1, expiresAt: resetTime } },
      { new: true, upsert: true }
    );
    return { totalHits: fresh.count, resetTime: fresh.expiresAt };
  } catch (err) {
    // Lost an upsert race; the winner created the window, so just increment it.
    if (err.code === 11000) {
      const retry = await RateLimitHit.findOneAndUpdate(
        { key },
        { $inc: { count: 1 } },
        { new: true }
      );
      if (retry) return { totalHits: retry.count, resetTime: retry.expiresAt };
    }
    throw err;
  }
};

const decrement = async (key) => {
  await RateLimitHit.findOneAndUpdate(
    { key, expiresAt: { $gt: new Date() }, count: { $gt: 0 } },
    { $inc: { count: -1 } }
  );
};

const resetKey = async (key) => {
  await RateLimitHit.deleteOne({ key });
};

module.exports = {
  consume,
  decrement,
  resetKey,
};
