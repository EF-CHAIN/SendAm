import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';

const ToastContext = createContext(null);

let toastIdCounter = 0;

/**
 * Icons for toast variants
 */
function SuccessIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ErrorIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  );
}

function WarningIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  );
}

function InfoIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
    </svg>
  );
}

function CloseIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

const TOAST_STYLES = {
  success: {
    container: 'bg-emerald-50 border-emerald-300 text-emerald-950 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-100',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    Icon: SuccessIcon,
    role: 'status',
    ariaLive: 'polite',
  },
  error: {
    container: 'bg-red-50 border-red-300 text-red-950 dark:bg-red-950 dark:border-red-800 dark:text-red-100',
    iconColor: 'text-red-600 dark:text-red-400',
    Icon: ErrorIcon,
    role: 'alert',
    ariaLive: 'assertive',
  },
  warning: {
    container: 'bg-amber-50 border-amber-300 text-amber-950 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-100',
    iconColor: 'text-amber-600 dark:text-amber-400',
    Icon: WarningIcon,
    role: 'status',
    ariaLive: 'polite',
  },
  info: {
    container: 'bg-teal-50 border-teal-300 text-teal-950 dark:bg-teal-950 dark:border-teal-800 dark:text-teal-100',
    iconColor: 'text-teal-600 dark:text-teal-400',
    Icon: InfoIcon,
    role: 'status',
    ariaLive: 'polite',
  },
};

/**
 * Single Toast Item component with entrance/exit animation and click-to-dismiss.
 */
function ToastItem({ toast, onDismiss }) {
  const { id, type = 'info', message, title, isExiting } = toast;
  const styleConfig = TOAST_STYLES[type] || TOAST_STYLES.info;
  const { Icon, iconColor, container, role, ariaLive } = styleConfig;

  return (
    <div
      role={role}
      aria-live={ariaLive}
      data-toast-id={id}
      data-toast-type={type}
      onClick={() => onDismiss(id)}
      className={`pointer-events-auto group relative flex items-start gap-3 w-full rounded-lg border p-4 shadow-lg transition-all duration-300 ease-in-out cursor-pointer select-none ${container} ${
        isExiting
          ? 'opacity-0 translate-x-4 scale-95 pointer-events-none'
          : 'opacity-100 translate-x-0 scale-100'
      }`}
    >
      <div className={`shrink-0 mt-0.5 ${iconColor}`}>
        <Icon />
      </div>

      <div className="flex-1 min-w-0 pr-2">
        {title && (
          <h4 className="text-sm font-semibold leading-5 mb-0.5">{title}</h4>
        )}
        <div className="text-sm leading-5 break-words font-medium opacity-90">{message}</div>
      </div>

      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(id);
        }}
        className="shrink-0 -mr-1 -mt-1 p-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-teal-500"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/**
 * ToastProvider — Shared toast notification provider with auto-dismiss timers.
 *
 * Acceptance Criteria:
 * - Stacks gracefully in bottom-right corner
 * - Automatically dismisses after 4 seconds (4000ms default)
 * - Dismissible via click (on toast card or close button)
 * - Smooth exit animations
 */
export function ToastProvider({ children, defaultDuration = 4000 }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());
  const exitTimersRef = useRef(new Map());

  // Clean up all pending timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
      exitTimersRef.current.forEach((timer) => clearTimeout(timer));
      exitTimersRef.current.clear();
    };
  }, []);

  const dismissToast = useCallback((id) => {
    // Clear auto-dismiss timer
    if (timersRef.current.has(id)) {
      clearTimeout(timersRef.current.get(id));
      timersRef.current.delete(id);
    }

    // If already exiting, no-op
    if (exitTimersRef.current.has(id)) {
      return;
    }

    // Trigger exit animation state
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isExiting: true } : t))
    );

    // Remove from state after exit animation finishes (300ms)
    const exitTimer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      exitTimersRef.current.delete(id);
    }, 300);

    exitTimersRef.current.set(id, exitTimer);
  }, []);

  const addToast = useCallback(
    (toastInput) => {
      const id = toastInput.id || `toast-${Date.now()}-${++toastIdCounter}`;
      const type = toastInput.type || 'info';
      const duration =
        toastInput.duration !== undefined ? toastInput.duration : defaultDuration;
      const message =
        typeof toastInput === 'string' ? toastInput : toastInput.message;
      const title = toastInput.title || null;

      const newToast = {
        id,
        type,
        message,
        title,
        duration,
        isExiting: false,
      };

      setToasts((prev) => [...prev, newToast]);

      // Schedule auto-dismiss if duration > 0 and finite
      if (typeof duration === 'number' && duration > 0 && Number.isFinite(duration)) {
        const timer = setTimeout(() => {
          dismissToast(id);
        }, duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [defaultDuration, dismissToast]
  );

  const clearAllToasts = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    setToasts((prev) => prev.map((t) => ({ ...t, isExiting: true })));
    setTimeout(() => {
      setToasts([]);
    }, 300);
  }, []);

  const toastHelpers = useMemo(() => {
    const fn = (messageOrOptions, options = {}) => {
      if (typeof messageOrOptions === 'string') {
        return addToast({ message: messageOrOptions, ...options });
      }
      return addToast(messageOrOptions);
    };

    fn.success = (message, options = {}) =>
      addToast({ message, type: 'success', ...options });
    fn.error = (message, options = {}) =>
      addToast({ message, type: 'error', ...options });
    fn.warning = (message, options = {}) =>
      addToast({ message, type: 'warning', ...options });
    fn.info = (message, options = {}) =>
      addToast({ message, type: 'info', ...options });
    fn.dismiss = (id) => dismissToast(id);
    fn.clear = () => clearAllToasts();

    return fn;
  }, [addToast, dismissToast, clearAllToasts]);

  const contextValue = useMemo(
    () => ({
      toast: toastHelpers,
      addToast,
      removeToast: dismissToast,
      dismiss: dismissToast,
      clearToasts: clearAllToasts,
      toasts,
    }),
    [toastHelpers, addToast, dismissToast, clearAllToasts, toasts]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {/* Toast viewport container: stacked gracefully in bottom-right corner */}
      <aside
        role="region"
        aria-label="Notifications"
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none p-4 sm:p-0"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </aside>
    </ToastContext.Provider>
  );
}

export default ToastProvider;

/**
 * useToast hook to access toast helpers from any component
 */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
