import { useEffect, useState, useCallback } from 'react';
import { getAdminSystemHealth } from '@/lib/adminApi';
import Loader from '@shared/Loader';
import { normalizeError } from '@shared/normalizeError.js';

export default function SystemHealth() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Incrementing retryCount causes the effect to re-run, triggering a re-fetch.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    const fetchHealth = async () => {
      try {
        const res = await getAdminSystemHealth();
        if (active) setHealth(res.data);
      } catch (err) {
        // normalizeError ensures raw error details never reach the UI
        if (active) setError(normalizeError(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchHealth();
    return () => { active = false; };
  }, [retryCount]);

  const handleRetry = useCallback(() => {
    setLoading(true);
    setError(null);
    setRetryCount((c) => c + 1);
  }, []);

  if (loading) return <div className="flex justify-center py-20"><Loader size={32} /></div>;

  // Safe error state — only renders the sanitized userMessage
  if (error) {
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

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">System Health</h1>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Object.entries(health || {}).map(([key, value]) => (
          <div key={key} className="rounded-lg border border-gray-100 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase text-gray-400">{key}</p>
            <p className="mt-2 break-words text-sm font-medium text-gray-800">{String(value)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
