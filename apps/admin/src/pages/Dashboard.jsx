import { useState, useEffect, useCallback } from 'react';
import { getAdminStats } from '@/lib/adminApi';
import StatCard from '@/components/StatCard';
import Loader from '@shared/Loader';
import { normalizeError } from '@shared/normalizeError.js';
import { Users, Wallet, ArrowRightLeft, CheckCircle2, XCircle, FileSearch } from 'lucide-react';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // retryCount is incremented by the retry button to trigger a re-fetch via
  // the effect dependency. Safe: incrementing doesn't mutate data.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    const fetchStats = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await getAdminStats();
        if (active) setStats(res.data);
      } catch (err) {
        // normalizeError ensures raw error.message / stack never reaches the UI
        if (active) setError(normalizeError(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchStats();
    return () => { active = false; };
  }, [retryCount]);

  const handleRetry = useCallback(() => setRetryCount((c) => c + 1), []);

  if (loading) return <div className="flex justify-center py-20"><Loader size={32} /></div>;

  // Safe error state — renders only the sanitized userMessage, never raw error details
  if (error) {
    return (
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
    );
  }

  return (
    <div className="min-w-0">
      <h1 className="text-xl sm:text-2xl font-bold mb-6 sm:mb-8">Dashboard Overview</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-6">
        <StatCard title="Total Users" value={stats?.totalUsers || 0} icon={Users} colorClass="text-blue-500" />
        <StatCard title="Managed Wallets" value={stats?.totalWallets || 0} icon={Wallet} colorClass="text-purple-500" />
        <StatCard title="All Transactions" value={stats?.totalTransactions || 0} icon={ArrowRightLeft} colorClass="text-gray-600" />
        <StatCard title="Successful Txs" value={stats?.successfulTransactions || 0} icon={CheckCircle2} colorClass="text-green-500" />
        <StatCard title="Failed Txs" value={stats?.failedTransactions || 0} icon={XCircle} colorClass="text-red-500" />
        <StatCard title="Pending Txs" value={stats?.pendingTransactions || 0} icon={ArrowRightLeft} colorClass="text-amber-500" />
        <StatCard title="Pending KYC" value={stats?.pendingKyc || 0} icon={FileSearch} colorClass="text-indigo-500" />
      </div>

      <div className="mt-8 sm:mt-12 bg-white p-5 sm:p-8 rounded-2xl border border-gray-100 shadow-sm">
        <h3 className="text-lg font-bold mb-4">Welcome to SendAm Admin</h3>
        <p className="text-gray-600 leading-relaxed max-w-3xl">
          This dashboard monitors the SendAm architecture: direct-custody wallets, payment orchestration, KYC, audit logs, and system health. All payments settle on Stellar.
        </p>
      </div>
    </div>
  );
}
