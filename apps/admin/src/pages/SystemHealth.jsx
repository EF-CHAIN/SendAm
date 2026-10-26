import { useEffect, useState, useCallback, useRef } from 'react';
import { getAdminSystemHealth } from '@/lib/adminApi';
import Loader from '@shared/Loader';
import { normalizeError } from '@shared/normalizeError.js';
import { RefreshCw, Pause, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

const INTERVAL_OPTIONS = [
  { label: '5s', value: 5 },
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: 'Paused', value: 0 },
];

// Subsystem groups for the health grid (#503). Keys not listed here fall into
// "Other" so a new probe added to the API still shows up.
const HEALTH_GROUPS = [
  {
    title: 'Core Services',
    keys: ['api', 'database', 'db', 'redis', 'queues', 'queue', 'workers', 'worker'],
  },
  {
    title: 'Payment Rails',
    keys: [
      'settlementRail',
      'custodyModel',
      'stellar',
      'stellarHorizon',
      'stellar_horizon',
      'horizon',
      'ramps',
      'ramp',
    ],
  },
  { title: 'Process Metrics', keys: ['uptime', 'memory'] },
];

function groupHealthEntries(health) {
  const entries = Object.entries(health || {});
  const claimed = new Set();
  const groups = HEALTH_GROUPS.map(({ title, keys }) => {
    const items = entries.filter(([key]) => keys.includes(key));
    items.forEach(([key]) => claimed.add(key));
    return { title, items };
  });
  groups.push({ title: 'Other', items: entries.filter(([key]) => !claimed.has(key)) });
  return groups.filter((group) => group.items.length > 0);
}

function getComponentHealth(value) {
  const str = String(value).toLowerCase();
  if (/down|unavailable|failed|error/i.test(str) || value === false) {
    return {
      status: 'down',
      cardClass: 'border-red-300 dark:border-red-800 bg-red-50/70 dark:bg-red-950/40 text-red-900 dark:text-red-200',
      badgeClass: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200 border border-red-200 dark:border-red-800',
      label: 'Critical / Down',
      Icon: XCircle,
    };
  }
  if (/degraded|slow|warning|timeout/i.test(str)) {
    return {
      status: 'degraded',
      cardClass: 'border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200',
      badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200 border border-amber-200 dark:border-amber-800',
      label: 'Degraded',
      Icon: AlertTriangle,
    };
  }
  return {
    status: 'ok',
    cardClass: 'border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-900',
    badgeClass: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800',
    label: 'Operational',
    Icon: CheckCircle2,
  };
}

export default function SystemHealth() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  // Auto-refresh interval (default: 15s) and countdown ring state (#774)
  const [intervalSeconds, setIntervalSeconds] = useState(15);
  const [secondsRemaining, setSecondsRemaining] = useState(15);

  const initialFetchDoneRef = useRef(false);

  useEffect(() => {
    let active = true;
    const fetchHealth = async () => {
      if (initialFetchDoneRef.current) {
        setRefreshing(true);
      }
      try {
        const res = await getAdminSystemHealth();
        if (active) {
          setHealth(res.data);
          setError(null);
        }
      } catch (err) {
        if (active) setError(normalizeError(err));
      } finally {
        if (active) {
          setLoading(false);
          setRefreshing(false);
          initialFetchDoneRef.current = true;
        }
      }
    };
    fetchHealth();
    return () => {
      active = false;
    };
  }, [retryCount]);

  // Interval timer for auto-refresh
  useEffect(() => {
    if (intervalSeconds <= 0) return undefined;

    const timer = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          setRetryCount((c) => c + 1);
          return intervalSeconds;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [intervalSeconds]);

  const handleIntervalChange = useCallback((e) => {
    const val = Number(e.target.value);
    setIntervalSeconds(val);
    setSecondsRemaining(val);
  }, []);

  const handleManualRefresh = useCallback(() => {
    setSecondsRemaining(intervalSeconds);
    setRetryCount((c) => c + 1);
  }, [intervalSeconds]);

  const handleRetry = useCallback(() => {
    setLoading(true);
    setError(null);
    setRetryCount((c) => c + 1);
  }, []);

  if (loading && !health && !error) {
    return (
      <div className="flex justify-center py-20">
        <Loader size={32} />
      </div>
    );
  }

  // Safe error state when no health data is available
  if (error && !health) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold">System Health</h1>
        <div
          role="alert"
          className="rounded-lg border border-red-100 bg-red-50 p-6 text-center"
        >
          <p className="mb-4 font-medium text-red-700">{error.userMessage}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const isPaused = intervalSeconds === 0;
  // Circular progress: dashoffset ranges from 0 (full) to 100 (depleted)
  const strokeDashoffset =
    !isPaused && intervalSeconds > 0
      ? (100 * (intervalSeconds - secondsRemaining)) / intervalSeconds
      : 0;

  return (
    <div className="space-y-6">
      {/* Top Header with Auto-refresh Interval Selector & Countdown Ring (#774) */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">System Health</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Real-time infrastructure probes, settlement rails, and custodial node availability.
          </p>
        </div>

        {/* Auto-Refresh Controls */}
        <div className="flex items-center gap-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 p-2 px-3 rounded-xl shadow-xs">
          {/* Circular Countdown Ring */}
          <div
            className="relative flex items-center justify-center w-7 h-7 flex-shrink-0"
            data-testid="countdown-ring"
            title={isPaused ? 'Auto-refresh paused' : `Reloads in ${secondsRemaining}s`}
          >
            <svg
              className="w-7 h-7 -rotate-90 transform"
              viewBox="0 0 36 36"
              aria-hidden="true"
            >
              <path
                className="text-gray-200 dark:text-slate-800"
                strokeWidth="3.5"
                stroke="currentColor"
                fill="none"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              />
              {!isPaused && (
                <path
                  className="text-teal-600 dark:text-teal-400 transition-all duration-500 ease-linear"
                  strokeDasharray="100, 100"
                  strokeDashoffset={strokeDashoffset}
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
              )}
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-bold text-gray-700 dark:text-gray-200">
              {isPaused ? (
                <Pause className="w-3 h-3 text-gray-400" />
              ) : (
                <span>{secondsRemaining}</span>
              )}
            </div>
          </div>

          {/* Refresh Dropdown Interval Selector */}
          <div className="flex items-center gap-1.5">
            <label htmlFor="refresh-interval-select" className="text-xs text-gray-500 font-medium">
              Refresh:
            </label>
            <select
              id="refresh-interval-select"
              value={intervalSeconds}
              onChange={handleIntervalChange}
              data-testid="refresh-interval-selector"
              aria-label="Auto-refresh interval"
              className="text-xs font-semibold bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-2 py-1 text-gray-800 dark:text-gray-200 focus:outline-hidden focus:ring-2 focus:ring-teal-500 cursor-pointer"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Manual Refresh Button */}
          <button
            type="button"
            onClick={handleManualRefresh}
            aria-label="Refresh now"
            title="Refresh now"
            className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin text-teal-600' : ''}`} />
          </button>
        </div>
      </div>

      {/* Inline Banner Error if background refetch failed */}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700"
        >
          {error.userMessage}
        </div>
      )}

      {/* Components grouped by subsystem, with Degraded / Critical highlighting */}
      {groupHealthEntries(health).map((group) => (
        <section key={group.title} aria-labelledby={`health-group-${group.title}`}>
          <h2
            id={`health-group-${group.title}`}
            className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
          >
            {group.title}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {group.items.map(([key, value]) => {
              const { status, cardClass, badgeClass, label, Icon } = getComponentHealth(value);

              return (
                <div
                  key={key}
                  data-testid={`health-card-${key}`}
                  data-status={status}
                  className={`rounded-xl border p-5 shadow-xs transition-colors flex flex-col justify-between ${cardClass}`}
                >
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${badgeClass}`}>
                      <Icon className="w-3 h-3" />
                      <span>{label}</span>
                    </span>
                  </div>
                  <p className="text-xs font-semibold uppercase text-gray-400">{key}</p>
                  <p className="mt-2 break-words text-sm font-medium text-gray-800 dark:text-gray-200">
                    {String(value)}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
