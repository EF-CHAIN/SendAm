import { useState, useEffect, useCallback, useRef } from 'react';
import api, { retryPendingRequests, getPendingRetryCount } from './api.js';

/**
 * NetworkStatusBanner — accessible sticky banner that detects network loss and restoration.
 *
 * Features:
 * - Detects browser offline / online events and reflects current connection state
 * - Renders an accessible top sticky alert banner while offline
 * - Automatically triggers request replay & query refetches upon reconnection
 * - Displays a transient "Back online" toast upon connection recovery
 * - Supports manual retry trigger
 *
 * Accessibility:
 * - role="alert" with aria-live="assertive" when connection drops
 * - role="status" with aria-live="polite" when connection recovers
 *
 * @param {Object} props
 * @param {() => void} [props.onReconnect] - Callback invoked when network recovers
 * @param {number} [props.toastDurationMs=3500] - Duration to display the back-online toast
 */
export default function NetworkStatusBanner({
  onReconnect,
  toastDurationMs = 3500,
}) {
  const [isOnline, setIsOnline] = useState(() => {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  });
  const [showRecoveredToast, setShowRecoveredToast] = useState(false);
  const [pendingRetries, setPendingRetries] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const toastTimeoutRef = useRef(null);

  const handleManualRetry = useCallback(async () => {
    setIsRetrying(true);
    try {
      if (typeof onReconnect === 'function') {
        await onReconnect();
      }
      await retryPendingRequests();
      setPendingRetries(getPendingRetryCount());
    } catch {
      // Retrying while still offline or degraded will re-enqueue
    } finally {
      setIsRetrying(false);
    }
  }, [onReconnect]);

  useEffect(() => {
    const handleOnlineEvent = async () => {
      setIsOnline(true);
      setShowRecoveredToast(true);

      // Auto-trigger retry queue & callback
      try {
        if (typeof onReconnect === 'function') {
          await onReconnect();
        }
        await retryPendingRequests();
        setPendingRetries(getPendingRetryCount());
      } catch {
        // Reconnection handler caught gracefully
      }

      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
      toastTimeoutRef.current = setTimeout(() => {
        setShowRecoveredToast(false);
      }, toastDurationMs);
    };

    const handleOfflineEvent = () => {
      setIsOnline(false);
      setShowRecoveredToast(false);
      setPendingRetries(getPendingRetryCount());
    };

    window.addEventListener('online', handleOnlineEvent);
    window.addEventListener('offline', handleOfflineEvent);

    return () => {
      window.removeEventListener('online', handleOnlineEvent);
      window.removeEventListener('offline', handleOfflineEvent);
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, [onReconnect, toastDurationMs]);

  // Offline Sticky Top Alert Banner
  if (!isOnline) {
    return (
      <aside
        role="alert"
        aria-live="assertive"
        className="sticky top-0 z-50 flex w-full items-center justify-between border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-900 shadow-sm"
      >
        <div className="flex items-center gap-2">
          {/* Offline Wifi Icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0 text-amber-700"
            aria-hidden="true"
          >
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          <span>
            <strong>Offline:</strong> Changes will sync once connection is restored.
            {pendingRetries > 0 && (
              <span className="ml-1 text-xs opacity-80">
                ({pendingRetries} action{pendingRetries > 1 ? 's' : ''} queued)
              </span>
            )}
          </span>
        </div>

        <button
          type="button"
          onClick={handleManualRetry}
          disabled={isRetrying}
          className="inline-flex items-center gap-1.5 rounded bg-amber-200/80 px-2.5 py-1 text-xs font-semibold text-amber-950 transition hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600 disabled:opacity-50"
        >
          {isRetrying ? 'Checking...' : 'Check connection'}
        </button>
      </aside>
    );
  }

  // Transient "Back Online" Toast
  if (showRecoveredToast) {
    return (
      <aside
        role="status"
        aria-live="polite"
        className="sticky top-0 z-50 flex w-full items-center justify-between border-b border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-900 shadow-sm transition-all"
      >
        <div className="flex items-center gap-2">
          {/* Check / Online Icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0 text-emerald-600"
            aria-hidden="true"
          >
            <path d="M5 12.55a11 11 0 0 1 14.08 0" />
            <path d="M1.42 9a16 16 0 0 1 21.16 0" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          <span>Back online — connection restored and data synchronized.</span>
        </div>
        <button
          type="button"
          onClick={() => setShowRecoveredToast(false)}
          className="rounded p-1 text-emerald-700 hover:bg-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          aria-label="Dismiss back online notice"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </aside>
    );
  }

  return null;
}
