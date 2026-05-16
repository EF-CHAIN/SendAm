'use client';
import { useState, useEffect } from 'react';
import { getAdminWallets } from '@/lib/adminApi';
import { formatDate } from '@/lib/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@/components/Loader';

export default function AdminWallets() {
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWallets = async () => {
      try {
        const res = await getAdminWallets();
        setWallets(res.data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchWallets();
  }, []);

  const columns = [
    { header: 'User Phone', render: (row) => row.userId?.phoneNumber || 'Unknown' },
    { header: 'Public Key', render: (row) => (
      <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded text-gray-600">
        {row.publicKey.substring(0, 12)}...{row.publicKey.substring(row.publicKey.length - 4)}
      </span>
    )},
    { header: 'Network', render: (row) => <span className="capitalize">{row.network}</span> },
    { header: 'Created At', render: (row) => formatDate(row.createdAt) },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Wallets</h1>
        <span className="text-sm text-gray-500 bg-white px-3 py-1 rounded-full border border-gray-200 shadow-sm">
          Total: {wallets.length}
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader /></div>
      ) : (
        <DataTable columns={columns} data={wallets} keyField="_id" />
      )}
    </div>
  );
}
