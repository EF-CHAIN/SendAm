import { useState, useEffect } from 'react';
import { getAdminTransactions } from '@/lib/adminApi';
import { formatDate } from '@shared/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';
import StatusBadge from '@/components/StatusBadge';
import Pagination from '@/components/Pagination';

export default function Transactions() {
  const [transactions, setTransactions] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTransactions = async () => {
      setLoading(true);
      try {
        const res = await getAdminTransactions({ page });
        setTransactions(res.data);
        setPagination(res.pagination);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchTransactions();
  }, [page]);

  const columns = [
    { header: 'User Phone', render: (row) => row.userId?.phoneNumber || 'Unknown' },
    { header: 'Type', render: (row) => <span className="capitalize font-medium text-gray-700">{row.type}</span> },
    { header: 'Amount', render: (row) => <span className="font-bold">{row.amount} {row.asset}</span> },
    { header: 'Destination', render: (row) => (
      <span className="font-mono text-xs text-gray-500">
        {row.destination ? `${row.destination.substring(0, 8)}...` : '-'}
      </span>
    )},
    { header: 'Receipt', render: (row) => row.explorerUrl ? (
      <a
        href={row.explorerUrl}
        target="_blank"
        rel="noreferrer"
        className="text-primary hover:underline text-sm font-medium"
      >
        View
      </a>
    ) : '-' },
    { header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { header: 'Date', render: (row) => formatDate(row.createdAt) },
  ];

  return (
    <div className="min-w-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold">Transactions</h1>
        <span className="text-sm text-gray-500 bg-white px-3 py-1 rounded-full border border-gray-200 shadow-sm">
          Total: {pagination?.total ?? transactions.length}
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader /></div>
      ) : (
        <>
          <DataTable columns={columns} data={transactions} keyField="_id" />
          <Pagination pagination={pagination} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
