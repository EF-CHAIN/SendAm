import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useRelativeTime from '@shared/useRelativeTime.js';

const NOW = new Date('2026-10-15T12:00:00Z').getTime();
const MIN = 60 * 1000;

describe('useRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the current text and updates every minute', () => {
    const { result } = renderHook(() => useRelativeTime(new Date(NOW)));
    expect(result.current).toBe('Just now');

    act(() => {
      vi.advanceTimersByTime(MIN);
    });
    expect(result.current).toBe('1m ago');

    act(() => {
      vi.advanceTimersByTime(2 * MIN);
    });
    expect(result.current).toBe('3m ago');
  });

  it('updates when the date changes', () => {
    const { result, rerender } = renderHook(({ date }) => useRelativeTime(date), {
      initialProps: { date: new Date(NOW) },
    });
    rerender({ date: new Date(NOW - 10 * MIN) });
    expect(result.current).toBe('10m ago');
  });

  it('returns an empty string for a missing date', () => {
    const { result } = renderHook(() => useRelativeTime(null));
    expect(result.current).toBe('');
  });

  it('clears its timer on unmount', () => {
    const { unmount } = renderHook(() => useRelativeTime(new Date(NOW)));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
