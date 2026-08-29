import { useState, useEffect } from 'react';
import { getAdminUsers } from '@/lib/adminApi';
import { useListQuery } from '@/lib/useListQuery';
import { formatDate } from '@shared/formatDate';
import DataTable from '@/components/DataTable';
import Loader from '@shared/Loader';
import StatusBadge from '@/components/StatusBadge';
import Pagination from '@/components/Pagination';
import FilterBar from '@/components/FilterBar';

export default function Users() {
  const { params, getFilter, setFilter, resetFilters, goNext, goPrev } = useListQuery(['phone']);
  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsers = async () => {
      setLoading(true);
      try {
        const res = await getAdminUsers(params);
        setUsers(res.data);
        setPagination(res.pagination);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchUsers();
  }, [params]);

  const columns = [
    { header: 'Phone Number', accessor: 'phoneNumber' },
    { header: 'WhatsApp Name', render: (row) => row.whatsappName || <span className="text-gray-400 italic">Unknown</span> },
    { header: 'Wallet', render: (row) => (
      row.wallets && row.wallets.length > 0
        ? <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100">Created</span>
        : <StatusBadge status="Pending" />
    )},
    { header: 'Created At', render: (row) => formatDate(row.createdAt) },
  ];

  return (
    <div className="min-w-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold">Users</h1>
      </div>

      <FilterBar
        fields={[{ key: 'phone', label: 'Phone', placeholder: 'Search phone…' }]}
        getFilter={getFilter}
        setFilter={setFilter}
        onReset={resetFilters}
      />

      {loading ? (
        <div className="flex justify-center py-20"><Loader /></div>
      ) : (
        <>
          <DataTable columns={columns} data={users} keyField="_id" />
          <Pagination pagination={pagination} onNext={goNext} onPrev={goPrev} />
        </>
      )}
    </div>
  );
}
