import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
global.document = dom.window.document;
global.window = dom.window;
globalThis.navigator = dom.window.navigator;
global.navigator = dom.window.navigator;
globalThis.Event = dom.window.Event;
global.Event = dom.window.Event;

import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import NetworkStatusBanner from './NetworkStatusBanner.jsx';
import api, { retryPendingRequests, getPendingRetryCount } from './api.js';

describe('NetworkStatusBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when browser is online initially', () => {
    const { container } = render(<NetworkStatusBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('displays the sticky offline alert banner when browser goes offline', () => {
    const { getByRole } = render(<NetworkStatusBanner />);

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    const alert = getByRole('alert');
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain('Offline: Changes will sync once connection is restored');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
  });

  it('displays a "Back online" toast and triggers onReconnect callback upon reconnection', async () => {
    const onReconnect = vi.fn();
    const { getByRole, queryByRole } = render(
      <NetworkStatusBanner onReconnect={onReconnect} toastDurationMs={2000} />
    );

    // Go offline first
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(getByRole('alert')).toBeDefined();

    // Reconnect
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    expect(onReconnect).toHaveBeenCalledTimes(1);

    const toast = getByRole('status');
    expect(toast).toBeDefined();
    expect(toast.textContent).toContain('Back online — connection restored');
    expect(toast.getAttribute('aria-live')).toBe('polite');

    // Fast forward timer to verify toast auto-dismiss
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(queryByRole('status')).toBeNull();
  });

  it('allows manual dismiss of the "Back online" toast', async () => {
    const { getByRole, queryByRole } = render(
      <NetworkStatusBanner toastDurationMs={5000} />
    );

    // Go offline then online
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    const dismissBtn = getByRole('button', { name: /dismiss/i });
    act(() => {
      fireEvent.click(dismissBtn);
    });

    expect(queryByRole('status')).toBeNull();
  });

  it('allows manual connection check from offline banner', async () => {
    const onReconnect = vi.fn().mockResolvedValue(true);
    const { getByRole } = render(<NetworkStatusBanner onReconnect={onReconnect} />);

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    const checkBtn = getByRole('button', { name: /check connection/i });
    await act(async () => {
      fireEvent.click(checkBtn);
    });

    expect(onReconnect).toHaveBeenCalled();
  });

  describe('api offline retry queue', () => {
    it('initializes with zero pending retries', () => {
      expect(getPendingRetryCount()).toBe(0);
    });

    it('returns 0 when draining an empty retry queue', async () => {
      const replayed = await retryPendingRequests();
      expect(replayed).toBe(0);
    });
  });
});
