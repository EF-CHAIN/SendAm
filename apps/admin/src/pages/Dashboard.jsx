import { useState, useEffect } from 'react';
import { getAdminStats } from '@/lib/adminApi';
import StatCard from '@/components/StatCard';
import Loader from '@shared/Loader';
import { Users, Wallet, ArrowRightLeft, CheckCircle2, XCircle, ShieldCheck, FileSearch, MapPin } from 'lucide-react';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await getAdminStats();
        setStats(res.data);
      } catch (err) {
        setError(err.message || 'Failed to load stats');
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, []);

  if (loading) return <div className="flex justify-center py-20"><Loader size={32} /></div>;
  if (error) return <div className="text-red-500 p-4 bg-red-50 rounded-lg">{error}</div>;

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
        <StatCard title="Open Escrows" value={stats?.openEscrows || 0} icon={ShieldCheck} colorClass="text-emerald-500" />
        <StatCard title="Pending KYC" value={stats?.pendingKyc || 0} icon={FileSearch} colorClass="text-indigo-500" />
        <StatCard title="Cash-out Locations" value={stats?.activeCashoutLocations || 0} icon={MapPin} colorClass="text-sky-500" />
      </div>

      <div className="mt-8 sm:mt-12 bg-white p-5 sm:p-8 rounded-2xl border border-gray-100 shadow-sm">
        <h3 className="text-lg font-bold mb-4">Welcome to SendAm Admin</h3>
        <p className="text-gray-600 leading-relaxed max-w-3xl">
          This dashboard monitors the upgraded SendAm architecture: managed wallets, payment routing, escrow, KYC, cash-out locations, audit logs, and system health. Lisk is the primary settlement layer, while Stellar is reserved for cross-border corridors.
        </p>
      </div>
    </div>
  );
}
