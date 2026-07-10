import { useState, useEffect } from 'react';
import { getAdminUsers } from '@/lib/adminApi';
import { formatDate } from '@shared/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';
import StatusBadge from '@/components/StatusBadge';
import Pagination from '@/components/Pagination';

export default function Users() {
  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsers = async () => {
      setLoading(true);
      try {
        const res = await getAdminUsers({ page });
        setUsers(res.data);
        setPagination(res.pagination);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchUsers();
  }, [page]);

  const columns = [
    { header: 'Phone Number', accessor: 'phoneNumber' },
    { header: 'WhatsApp Name', render: (row) => row.whatsappName || <span className="text-gray-400 italic">Unknown</span> },
    { header: 'Wallet Status', render: (row) => <StatusBadge status={row.walletId ? 'Created' : 'Pending'} /> },
    { header: 'Network', render: (row) => row.walletId?.network || '-' },
    { header: 'Created At', render: (row) => formatDate(row.createdAt) },
  ];

  return (
    <div className="min-w-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold">Users</h1>
        <span className="text-sm text-gray-500 bg-white px-3 py-1 rounded-full border border-gray-200 shadow-sm">
          Total: {pagination?.total ?? users.length}
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader /></div>
      ) : (
        <>
          <DataTable columns={columns} data={users} keyField="_id" />
          <Pagination pagination={pagination} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
