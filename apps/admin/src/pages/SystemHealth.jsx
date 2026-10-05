import { useEffect, useState, useCallback } from 'react';
import { getAdminSystemHealth } from '@/lib/adminApi';
import Loader from '@shared/Loader';
import { normalizeError } from '@shared/normalizeError.js';

const REFRESH_OPTIONS = [15, 30, 60];

const statusClasses = {
  operational: 'border border-emerald-200 bg-emerald-100 text-emerald-700',
  degraded: 'border border-amber-200 bg-amber-100 text-amber-700',
  down: 'border border-red-200 bg-red-100 text-red-700',
  unknown: 'border border-slate-200 bg-slate-100 text-slate-600',
};

const pickValue = (source, keys) => {
  if (!source || typeof source !== 'object') return undefined;

  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      return source[key];
    }
  }

  return undefined;
};

const normalizeValue = (value) => {
  if (value === undefined || value === null || value === '') return 'Unknown';

  if (typeof value === 'object') {
    if (value.status !== undefined) return normalizeValue(value.status);
    if (value.state !== undefined) return normalizeValue(value.state);
    if (value.value !== undefined) return normalizeValue(value.value);
    if (value.message !== undefined) return normalizeValue(value.message);
    return JSON.stringify(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return String(value).trim();
};

const classifyStatus = (value) => {
  const raw = normalizeValue(value).toLowerCase();

  if (!raw || raw === 'unknown' || raw === 'n/a') {
    return { label: 'Unknown', tone: 'unknown' };
  }

  if (
    ['ok', 'healthy', 'ready', 'available', 'online', 'running', 'success', 'operational', 'up', 'active', 'connected', 'configured', 'pass', 'passed', 'stable'].some((token) => raw.includes(token))
  ) {
    return { label: 'Operational', tone: 'operational' };
  }

  if (
    ['warning', 'degraded', 'partial', 'slow', 'limited', 'stale', 'retrying', 'degraded', 'unstable'].some((token) => raw.includes(token))
  ) {
    return { label: 'Degraded', tone: 'degraded' };
  }

  if (
    ['down', 'error', 'failed', 'offline', 'unavailable', 'disconnected', 'timeout', 'critical', 'blocked', 'not configured'].some((token) => raw.includes(token))
  ) {
    return { label: 'Down', tone: 'down' };
  }

  return { label: 'Operational', tone: 'operational' };
};

const getHealthGroups = (payload) => {
  const source = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object' ? payload.data : payload || {};
  const groups = [
    {
      title: 'Core Services',
      metrics: [
        { label: 'Database', keys: ['database', 'db'] },
        { label: 'Redis', keys: ['redis', 'queue', 'queues'] },
        { label: 'Workers', keys: ['workers', 'worker', 'queue', 'queues'] },
      ],
    },
    {
      title: 'Payment Rails',
      metrics: [
        { label: 'Stellar Horizon', keys: ['stellarHorizon', 'stellar_horizon', 'horizon', 'stellar'] },
        { label: 'Ramps', keys: ['ramps', 'ramp'] },
      ],
    },
    {
      title: 'Process Metrics',
      metrics: [
        { label: 'Uptime', keys: ['uptime'] },
        { label: 'Memory', keys: ['memory'] },
      ],
    },
  ];

  return groups.map((group) => ({
    ...group,
    metrics: group.metrics.map((metric) => {
      const value = pickValue(source, metric.keys);
      const safeValue = value === undefined ? 'Unknown' : value;
      const status = classifyStatus(safeValue);

      return {
        label: metric.label,
        value: normalizeValue(safeValue),
        status,
      };
    }),
  }));
};

export default function SystemHealth() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(15);

  useEffect(() => {
    let active = true;

    const fetchHealth = async () => {
      setLoading(true);
      try {
        const res = await getAdminSystemHealth();
        if (active) setHealth(res?.data ?? res ?? null);
      } catch (err) {
        if (active) setError(normalizeError(err));
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchHealth();
    return () => { active = false; };
  }, [retryCount]);

  useEffect(() => {
    if (!autoRefresh || !REFRESH_OPTIONS.includes(refreshInterval)) return undefined;

    const timer = window.setInterval(() => {
      setRetryCount((count) => count + 1);
    }, refreshInterval * 1000);

    return () => window.clearInterval(timer);
  }, [autoRefresh, refreshInterval]);

  const handleRefresh = useCallback(() => {
    setRetryCount((count) => count + 1);
  }, []);

  const handleRetry = useCallback(() => {
    setLoading(true);
    setError(null);
    setRetryCount((count) => count + 1);
  }, []);

  const healthGroups = getHealthGroups(health);
  const lastUpdated = health?.timestamp ? new Date(health.timestamp).toLocaleString() : null;

  if (loading) {
    return <div className="flex justify-center py-20"><Loader size={32} /></div>;
  }

  if (error) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold">System Health</h1>
        <div role="alert" className="rounded-lg border border-red-100 bg-red-50 p-6 text-center">
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold">System Health</h1>
          {lastUpdated && (
            <p className="mt-1 text-sm text-slate-500">Last checked {lastUpdated}</p>
          )}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            aria-pressed={autoRefresh}
            onClick={() => setAutoRefresh((value) => !value)}
            className={`inline-flex items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${autoRefresh ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
          >
            Auto Refresh
          </button>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <span className="sr-only">Refresh interval</span>
            <select
              aria-label="Refresh interval"
              value={refreshInterval}
              onChange={(event) => setRefreshInterval(Number(event.target.value))}
              disabled={!autoRefresh}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 outline-none focus:border-primary disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              {REFRESH_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}s</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={handleRefresh}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="space-y-6">
        {healthGroups.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
            No health metrics are available yet.
          </div>
        ) : (
          healthGroups.map((group) => (
            <section key={group.title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">{group.title}</h2>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Status overview</span>
              </div>

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {group.metrics.map((metric) => (
                  <div key={metric.label} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-slate-700">{metric.label}</p>
                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusClasses[metric.status.tone] || statusClasses.unknown}`}>
                        {metric.status.label}
                      </span>
                    </div>
                    <p className="mt-3 break-words text-sm text-slate-600">{metric.value}</p>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
