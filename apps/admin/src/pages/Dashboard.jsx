import { useState, useEffect } from 'react';
import { getAdminStats } from '@/lib/adminApi';
import StatCard from '@/components/StatCard';
import Loader from '@shared/Loader';
import { Users, Wallet, ArrowRightLeft, CheckCircle2, XCircle } from 'lucide-react';

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

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 sm:gap-6">
        <StatCard title="Total Users" value={stats?.totalUsers || 0} icon={Users} colorClass="text-blue-500" />
        <StatCard title="Total Wallets" value={stats?.totalWallets || 0} icon={Wallet} colorClass="text-purple-500" />
        <StatCard title="All Transactions" value={stats?.totalTransactions || 0} icon={ArrowRightLeft} colorClass="text-gray-600" />
        <StatCard title="Successful Txs" value={stats?.successfulTransactions || 0} icon={CheckCircle2} colorClass="text-green-500" />
        <StatCard title="Failed Txs" value={stats?.failedTransactions || 0} icon={XCircle} colorClass="text-red-500" />
      </div>

      <div className="mt-8 sm:mt-12 bg-white p-5 sm:p-8 rounded-2xl border border-gray-100 shadow-sm">
        <h3 className="text-lg font-bold mb-4">Welcome to SendAm Admin</h3>
        <p className="text-gray-600 leading-relaxed max-w-3xl">
          This dashboard provides a high-level overview of the SendAm ecosystem. Use the sidebar to navigate through users, wallets, and transactions in detail. Please note that since this is an MVP on the Stellar Testnet, some transactions may fail if test accounts run out of funds or the testnet is reset.
        </p>
      </div>
    </div>
  );
}
