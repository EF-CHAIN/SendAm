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

  it('displays green Connection restored. Syncing... toast for 3s upon reconnect', async () => {
    const onReconnect = vi.fn().mockResolvedValue(true);
    const { getByRole, queryByRole } = render(
      <NetworkStatusBanner onReconnect={onReconnect} toastDurationMs={3000} />
    );

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    const toast = getByRole('status');
    expect(toast).toBeDefined();
    expect(toast.textContent).toContain('Connection restored. Syncing...');
    expect(onReconnect).toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(queryByRole('status')).toBeNull();
  });

  it('displays offline pending queue counter badge and view pending operations button', () => {
    const onViewPendingActions = vi.fn();
    const { getByRole, getByTestId } = render(
      <NetworkStatusBanner pendingActions={3} onViewPendingActions={onViewPendingActions} />
    );

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    const badge = getByTestId('pending-actions-badge');
    expect(badge).toBeDefined();
    expect(badge.textContent).toBe('3 actions queued for replay when online');

    const viewBtn = getByRole('button', { name: /view pending operations/i });
    expect(viewBtn).toBeDefined();

    act(() => {
      fireEvent.click(viewBtn);
    });

    expect(onViewPendingActions).toHaveBeenCalled();
    const dialog = getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(dialog.textContent).toContain('Pending Offline Operations');
    expect(dialog.textContent).toContain('Operation #1');
    expect(dialog.textContent).toContain('Operation #2');
    expect(dialog.textContent).toContain('Operation #3');
  });

  it('increments badge as actions are queued offline and decrements as replay succeeds', async () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <NetworkStatusBanner pendingActions={0} />
    );

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(queryByTestId('pending-actions-badge')).toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('offline-action-queued', { detail: { count: 3 } })
      );
    });

    const badge = getByTestId('pending-actions-badge');
    expect(badge.textContent).toBe('3 actions queued for replay when online');

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('offline-action-replayed', { detail: { count: 0 } })
      );
    });

    rerender(<NetworkStatusBanner pendingActions={0} />);
    expect(queryByTestId('pending-actions-badge')).toBeNull();
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
