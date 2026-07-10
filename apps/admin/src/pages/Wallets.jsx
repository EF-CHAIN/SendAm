import { useState, useEffect } from 'react';
import { getAdminWallets } from '@/lib/adminApi';
import { formatDate } from '@shared/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';
import Pagination from '@/components/Pagination';

export default function Wallets() {
  const [wallets, setWallets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWallets = async () => {
      setLoading(true);
      try {
        const res = await getAdminWallets({ page });
        setWallets(res.data);
        setPagination(res.pagination);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchWallets();
  }, [page]);

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
    <div className="min-w-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold">Wallets</h1>
        <span className="text-sm text-gray-500 bg-white px-3 py-1 rounded-full border border-gray-200 shadow-sm">
          Total: {pagination?.total ?? wallets.length}
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader /></div>
      ) : (
        <>
          <DataTable columns={columns} data={wallets} keyField="_id" />
          <Pagination pagination={pagination} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
