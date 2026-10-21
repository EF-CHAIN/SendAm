import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDate,
  formatRelativeTime,
  getNextRelativeTimeUpdateDelay,
  subscribeRelativeTime,
} from '@shared/formatDate.js';

const NOW = new Date('2026-10-15T12:00:00Z').getTime();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW - ms);

describe('formatDate (unchanged)', () => {
  it('returns an empty string for falsy input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('')).toBe('');
  });

  it('formats a timestamp as medium date and short time', () => {
    expect(formatDate('2026-09-25T13:45:00')).toBe('Sep 25, 2026, 1:45 PM');
  });
});

describe('formatRelativeTime', () => {
  it('says "Just now" for under a minute', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('Just now');
    expect(formatRelativeTime(ago(59 * SEC), NOW)).toBe('Just now');
  });

  it('uses minutes under an hour', () => {
    expect(formatRelativeTime(ago(MIN), NOW)).toBe('1m ago');
    expect(formatRelativeTime(ago(5 * MIN + 30 * SEC), NOW)).toBe('5m ago');
    expect(formatRelativeTime(ago(59 * MIN + 59 * SEC), NOW)).toBe('59m ago');
  });

  it('uses hours under a day', () => {
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe('1h ago');
    expect(formatRelativeTime(ago(2 * HOUR + 10 * MIN), NOW)).toBe('2h ago');
    expect(formatRelativeTime(ago(DAY - SEC), NOW)).toBe('23h ago');
  });

  it('falls back to the full date after 24 hours', () => {
    const old = ago(DAY);
    expect(formatRelativeTime(old, NOW)).toBe(formatDate(old));
    expect(formatRelativeTime(ago(10 * DAY), NOW)).toBe(formatDate(ago(10 * DAY)));
  });

  it('accepts ISO strings and epoch numbers', () => {
    expect(formatRelativeTime(new Date(NOW - 5 * MIN).toISOString(), NOW)).toBe('5m ago');
    expect(formatRelativeTime(NOW - 2 * HOUR, NOW)).toBe('2h ago');
  });

  it('treats small clock skew in the future as "Just now"', () => {
    expect(formatRelativeTime(new Date(NOW + 30 * SEC), NOW)).toBe('Just now');
  });

  it('uses Intl.RelativeTimeFormat for timestamps further in the future', () => {
    expect(formatRelativeTime(new Date(NOW + 5 * MIN), NOW)).toBe('in 5 minutes');
    expect(formatRelativeTime(new Date(NOW + 3 * HOUR), NOW)).toBe('in 3 hours');
    const far = new Date(NOW + 3 * DAY);
    expect(formatRelativeTime(far, NOW)).toBe(formatDate(far));
  });

  it('returns an empty string for empty or invalid input instead of throwing', () => {
    expect(formatRelativeTime(null, NOW)).toBe('');
    expect(formatRelativeTime(undefined, NOW)).toBe('');
    expect(formatRelativeTime('', NOW)).toBe('');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });

  it('defaults to the current time', () => {
    expect(formatRelativeTime(new Date(Date.now() - 3 * MIN))).toBe('3m ago');
  });
});

describe('getNextRelativeTimeUpdateDelay', () => {
  it('ticks on the next minute boundary for events under an hour old', () => {
    expect(getNextRelativeTimeUpdateDelay(ago(0), NOW)).toBe(MIN);
    expect(getNextRelativeTimeUpdateDelay(ago(20 * SEC), NOW)).toBe(40 * SEC);
    expect(getNextRelativeTimeUpdateDelay(ago(5 * MIN + 10 * SEC), NOW)).toBe(50 * SEC);
  });

  it('ticks hourly between 1 and 24 hours', () => {
    expect(getNextRelativeTimeUpdateDelay(ago(HOUR + 10 * MIN), NOW)).toBe(50 * MIN);
  });

  it('stops after 24 hours and for invalid input', () => {
    expect(getNextRelativeTimeUpdateDelay(ago(DAY), NOW)).toBeNull();
    expect(getNextRelativeTimeUpdateDelay(ago(3 * DAY), NOW)).toBeNull();
    expect(getNextRelativeTimeUpdateDelay('nope', NOW)).toBeNull();
  });
});

describe('subscribeRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits immediately, then every minute as the event ages', () => {
    const cb = vi.fn();
    subscribeRelativeTime(new Date(NOW), cb);
    expect(cb).toHaveBeenLastCalledWith('Just now');

    vi.advanceTimersByTime(MIN);
    expect(cb).toHaveBeenLastCalledWith('1m ago');

    vi.advanceTimersByTime(4 * MIN);
    expect(cb).toHaveBeenLastCalledWith('5m ago');
    expect(cb).toHaveBeenCalledTimes(6);
  });

  it('moves to hourly ticks and finally stops at the absolute date', () => {
    const date = new Date(NOW - 59 * MIN);
    const cb = vi.fn();
    subscribeRelativeTime(date, cb);

    vi.advanceTimersByTime(MIN);
    expect(cb).toHaveBeenLastCalledWith('1h ago');

    vi.advanceTimersByTime(23 * HOUR);
    expect(cb).toHaveBeenLastCalledWith(formatDate(date));

    const calls = cb.mock.calls.length;
    vi.advanceTimersByTime(5 * DAY);
    expect(cb).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops ticking after unsubscribe', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeRelativeTime(new Date(NOW), cb);
    unsubscribe();
    vi.advanceTimersByTime(10 * MIN);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule anything for invalid dates', () => {
    const cb = vi.fn();
    subscribeRelativeTime('garbage', cb);
    expect(cb).toHaveBeenCalledWith('');
    expect(vi.getTimerCount()).toBe(0);
  });
});
