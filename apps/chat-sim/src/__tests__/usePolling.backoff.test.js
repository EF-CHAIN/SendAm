import {
  ACTIVE_POLL_INTERVAL_MS,
  BACKGROUND_POLL_INTERVAL_MS,
  MAX_BACKOFF_MS,
  calculateNextInterval,
} from '../usePolling';

describe('usePolling interval calculation and backoff logic', () => {
  it('returns default active interval (3000ms) when tab is active with 0 errors', () => {
    const interval = calculateNextInterval({ isHidden: false, consecutiveErrors: 0 });
    expect(interval).toBe(ACTIVE_POLL_INTERVAL_MS);
    expect(interval).toBe(3000);
  });

  it('throttles to background interval (30000ms) when tab is hidden', () => {
    const interval = calculateNextInterval({ isHidden: true, consecutiveErrors: 0 });
    expect(interval).toBe(BACKGROUND_POLL_INTERVAL_MS);
    expect(interval).toBe(30000);
  });

  it('keeps background interval even when there are errors while hidden', () => {
    const interval = calculateNextInterval({ isHidden: true, consecutiveErrors: 2 });
    expect(interval).toBe(BACKGROUND_POLL_INTERVAL_MS);
    expect(interval).toBe(30000);
  });

  it('applies exponential backoff on consecutive errors when tab is active', () => {
    // 1 error: 3000 * 2^1 = 6000ms
    expect(calculateNextInterval({ isHidden: false, consecutiveErrors: 1 })).toBe(6000);
    // 2 errors: 3000 * 2^2 = 12000ms
    expect(calculateNextInterval({ isHidden: false, consecutiveErrors: 2 })).toBe(12000);
    // 3 errors: 3000 * 2^3 = 24000ms
    expect(calculateNextInterval({ isHidden: false, consecutiveErrors: 3 })).toBe(24000);
  });

  it('caps backoff interval at MAX_BACKOFF_MS (30000ms)', () => {
    // 4 errors: 3000 * 2^4 = 48000ms -> capped at 30000ms
    expect(calculateNextInterval({ isHidden: false, consecutiveErrors: 4 })).toBe(MAX_BACKOFF_MS);
    expect(calculateNextInterval({ isHidden: false, consecutiveErrors: 10 })).toBe(MAX_BACKOFF_MS);
  });
});
