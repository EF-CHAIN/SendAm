'use client';
import { useState, useEffect } from 'react';
import { getAdminTransactions } from '@/lib/adminApi';
import { formatDate } from '@/lib/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@/components/Loader';
import StatusBadge from '@/components/StatusBadge';

export default function AdminTransactions() {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTransactions = async () => {
      try {
        const res = await getAdminTransactions();
        setTransactions(res.data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchTransactions();
  }, []);

  const columns = [
    { header: 'User Phone', render: (row) => row.userId?.phoneNumber || 'Unknown' },
    { header: 'Type', render: (row) => <span className="capitalize font-medium text-gray-700">{row.type}</span> },
    { header: 'Amount', render: (row) => <span className="font-bold">{row.amount} {row.asset}</span> },
    { header: 'Destination', render: (row) => (
      <span className="font-mono text-xs text-gray-500">
        {row.destination ? `${row.destination.substring(0, 8)}...` : '-'}
      </span>
    )},
    { header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { header: 'Date', render: (row) => formatDate(row.createdAt) },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Transactions</h1>
        <span className="text-sm text-gray-500 bg-white px-3 py-1 rounded-full border border-gray-200 shadow-sm">
          Total: {transactions.length}
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader /></div>
      ) : (
        <DataTable columns={columns} data={transactions} keyField="_id" />
      )}
    </div>
  );
}
