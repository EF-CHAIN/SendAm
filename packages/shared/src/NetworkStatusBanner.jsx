import { useState, useEffect, useCallback, useRef } from 'react';
import api, { retryPendingRequests, getPendingRetryCount } from './api.js';

/**
 * NetworkStatusBanner: accessible sticky banner that detects network loss and restoration.
 *
 * Features:
 * - Detects browser offline / online events and reflects current connection state
 * - Renders an accessible top sticky alert banner while offline
 * - Displays pending action queue badge: 'X actions queued for replay when online'
 * - Provides button and modal to view pending operations
 * - Displays automatic retry countdown timer during offline state
 * - Automatically triggers request replay & query refetches upon reconnection
 * - Displays transient green 'Connection restored. Syncing...' toast for 3s upon reconnection
 * - Supports manual retry trigger
 *
 * Accessibility:
 * - role="alert" with aria-live="assertive" when connection drops
 * - role="status" with aria-live="polite" when connection recovers
 * - role="dialog" with aria-modal="true" for pending operations modal
 *
 * @param {Object} props
 * @param {() => void} [props.onReconnect] - Callback invoked when network recovers
 * @param {number} [props.toastDurationMs=3000] - Duration to display the back-online toast
 * @param {number} [props.pendingActions] - Explicit pending actions count override
 * @param {() => void} [props.onViewPendingActions] - Callback when viewing pending operations
 */
export default function NetworkStatusBanner({
  onReconnect,
  toastDurationMs = 3000,
  pendingActions,
  onViewPendingActions,
}) {
  const [isOnline, setIsOnline] = useState(() => {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  });
  const [showRecoveredToast, setShowRecoveredToast] = useState(false);
  const [pendingRetries, setPendingRetries] = useState(() => {
    if (typeof pendingActions === 'number') return pendingActions;
    return getPendingRetryCount();
  });
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(15);
  const [showPendingModal, setShowPendingModal] = useState(false);

  const toastTimeoutRef = useRef(null);
  const countdownIntervalRef = useRef(null);

  // Sync external pendingActions prop if provided
  useEffect(() => {
    if (typeof pendingActions === 'number') {
      setPendingRetries(pendingActions);
    }
  }, [pendingActions]);

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
      setRetryCountdown(15);
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
      setRetryCountdown(15);
    };

    const handleQueueChange = (e) => {
      if (e?.detail && typeof e.detail.count === 'number') {
        setPendingRetries(e.detail.count);
      } else {
        setPendingRetries(getPendingRetryCount());
      }
    };

    window.addEventListener('online', handleOnlineEvent);
    window.addEventListener('offline', handleOfflineEvent);
    window.addEventListener('offline-action-queued', handleQueueChange);
    window.addEventListener('offline-action-replayed', handleQueueChange);
    window.addEventListener('offline-queue-change', handleQueueChange);

    return () => {
      window.removeEventListener('online', handleOnlineEvent);
      window.removeEventListener('offline', handleOfflineEvent);
      window.removeEventListener('offline-action-queued', handleQueueChange);
      window.removeEventListener('offline-action-replayed', handleQueueChange);
      window.removeEventListener('offline-queue-change', handleQueueChange);
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, [onReconnect, toastDurationMs]);

  // Periodic polling for pending retry count and countdown while offline
  useEffect(() => {
    if (isOnline) {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      return;
    }

    countdownIntervalRef.current = setInterval(() => {
      setPendingRetries((prev) => {
        const currentCount = getPendingRetryCount();
        return currentCount !== prev ? currentCount : prev;
      });

      setRetryCountdown((prev) => {
        if (prev <= 1) {
          handleManualRetry();
          return 15;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
    };
  }, [isOnline, handleManualRetry]);

  // Offline Sticky Top Alert Banner
  if (!isOnline) {
    return (
      <>
        <aside
          role="alert"
          aria-live="assertive"
          className="sticky top-0 z-50 flex w-full flex-wrap items-center justify-between gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-900 shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
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
            </span>
            {pendingRetries > 0 && (
              <span
                data-testid="pending-actions-badge"
                testID="pending-actions-badge"
                className="inline-flex items-center gap-1 rounded-full bg-amber-200/90 px-2.5 py-0.5 text-xs font-semibold text-amber-950"
              >
                {pendingRetries} action{pendingRetries === 1 ? '' : 's'} queued for replay when online
              </span>
            )}
            {pendingRetries > 0 && (
              <button
                type="button"
                data-testid="view-pending-operations-btn"
                onClick={() => {
                  setShowPendingModal(true);
                  if (typeof onViewPendingActions === 'function') {
                    onViewPendingActions();
                  }
                }}
                className="inline-flex items-center text-xs font-semibold text-amber-900 underline hover:text-amber-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600"
                aria-label="View pending operations"
              >
                View pending operations
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-800" aria-label="Retry countdown">
              Retry in {retryCountdown}s
            </span>
            <button
              type="button"
              onClick={handleManualRetry}
              disabled={isRetrying}
              className="inline-flex items-center gap-1.5 rounded bg-amber-200/80 px-2.5 py-1 text-xs font-semibold text-amber-950 transition hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600 disabled:opacity-50"
            >
              {isRetrying ? 'Checking...' : 'Check connection'}
            </button>
          </div>
        </aside>

        {showPendingModal && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pending-operations-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          >
            <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-5 shadow-xl">
              <div className="flex items-center justify-between border-b border-gray-200 pb-3">
                <h3 id="pending-operations-title" className="text-base font-semibold text-gray-900">
                  Pending Offline Operations
                </h3>
                <button
                  type="button"
                  onClick={() => setShowPendingModal(false)}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  aria-label="Close pending operations dialog"
                >
                  ✕
                </button>
              </div>
              <div className="py-4">
                <p className="mb-3 text-sm text-gray-600">
                  {pendingRetries} action{pendingRetries === 1 ? '' : 's'} queued in memory waiting for connection restoration:
                </p>
                <div className="max-h-60 overflow-y-auto rounded border border-gray-100 bg-gray-50 p-2 space-y-2">
                  {Array.from({ length: pendingRetries }).map((_, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded bg-white p-2 text-xs shadow-sm"
                    >
                      <span className="font-medium text-gray-800">
                        Operation #{idx + 1}: Idempotent API query
                      </span>
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 font-medium">
                        Queued for replay
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowPendingModal(false)}
                  className="rounded bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </>
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
          <span>Connection restored. Syncing... Back online — connection restored and data synchronized.</span>
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
