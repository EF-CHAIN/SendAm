import { useEffect, useState } from 'react';
import { getAdminSystemHealth } from '@/lib/adminApi';
import Loader from '@shared/Loader';

export default function SystemHealth() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAdminSystemHealth().then((res) => setHealth(res.data)).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center py-20"><Loader size={32} /></div>;

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
