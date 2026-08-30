import { useState, useEffect } from 'react';
import { 
  getAdminUsers, 
  getUserOnboardingStatus, 
  deactivateUserAccount, 
  reactivateUserAccount, 
  downloadUserEvidencePackage 
} from '@/lib/adminApi';
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
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  // Modals state
  const [onboardingUser, setOnboardingUser] = useState(null);
  const [onboardingData, setOnboardingData] = useState(null);
  const [onboardingLoading, setOnboardingLoading] = useState(false);

  const [deactivateModalUser, setDeactivateModalUser] = useState(null);
  const [deactivateReason, setDeactivateReason] = useState('risk_score_exceeded');
  const [deactivateNotes, setDeactivateNotes] = useState('');
  const [deactivateForce, setDeactivateForce] = useState(false);
  const [submittingAction, setSubmittingAction] = useState(false);

  const [reactivateModalUser, setReactivateModalUser] = useState(null);
  const [reactivateNotes, setReactivateNotes] = useState('');
  const [reactivateApprovedBy, setReactivateApprovedBy] = useState('');

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await getAdminUsers(params);
      setUsers(res.data || []);
      setPagination(res.pagination);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [params]);

  const handleViewOnboarding = async (user) => {
    setOnboardingUser(user);
    setOnboardingLoading(true);
    try {
      const res = await getUserOnboardingStatus(user.id);
      setOnboardingData(res.data);
    } catch (err) {
      setActionError(err.response?.data?.message || 'Failed to load onboarding status');
    } finally {
      setOnboardingLoading(false);
    }
  };

  const handleDownloadEvidence = async (userId) => {
    setActionError('');
    setActionSuccess('');
    try {
      await downloadUserEvidencePackage(userId);
      setActionSuccess('Compliance evidence package downloaded successfully.');
    } catch (err) {
      setActionError(err.response?.data?.message || 'Failed to export compliance evidence');
    }
  };

  const handleDeactivate = async (e) => {
    e.preventDefault();
    if (!deactivateModalUser) return;
    setSubmittingAction(true);
    setActionError('');
    try {
      await deactivateUserAccount(deactivateModalUser.id, {
        reason: deactivateReason,
        notes: deactivateNotes,
        force: deactivateForce,
      });
      setDeactivateModalUser(null);
      setDeactivateNotes('');
      setActionSuccess('Account deactivated successfully.');
      await fetchUsers();
    } catch (err) {
      setActionError(err.response?.data?.message || err.message || 'Failed to deactivate account');
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleReactivate = async (e) => {
    e.preventDefault();
    if (!reactivateModalUser) return;
    setSubmittingAction(true);
    setActionError('');
    try {
      await reactivateUserAccount(reactivateModalUser.id, {
        notes: reactivateNotes,
        approvedBy: reactivateApprovedBy || undefined,
      });
      setReactivateModalUser(null);
      setReactivateNotes('');
      setReactivateApprovedBy('');
      setActionSuccess('Account reactivated successfully.');
      await fetchUsers();
    } catch (err) {
      setActionError(err.response?.data?.message || err.message || 'Failed to reactivate account');
    } finally {
      setSubmittingAction(false);
    }
  };

  const columns = [
    { header: 'Phone Number', accessor: 'phoneNumber' },
    { header: 'WhatsApp Name', render: (row) => row.whatsappName || <span className="text-gray-400 italic">Unknown</span> },
    { 
      header: 'Status', 
      render: (row) => row.deactivatedAt ? (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800" title={`Reason: ${row.deactivationReason || 'N/A'}`}>
          Deactivated
        </span>
      ) : (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
          Active
        </span>
      )
    },
    { 
      header: 'Wallet', 
      render: (row) => (
        row.wallets && row.wallets.length > 0
          ? <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 font-medium">Created</span>
          : <StatusBadge status="Pending" />
      )
    },
    { header: 'Created At', render: (row) => formatDate(row.createdAt) },
    {
      header: 'Actions',
      render: (row) => (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleViewOnboarding(row)}
            className="text-xs px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded transition"
          >
            Onboarding
          </button>
          <button
            type="button"
            onClick={() => handleDownloadEvidence(row.id)}
            className="text-xs px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 font-medium rounded transition"
            title="Download JSON Compliance Evidence"
          >
            Evidence
          </button>
          {row.deactivatedAt ? (
            <button
              type="button"
              onClick={() => { setActionError(''); setReactivateModalUser(row); }}
              className="text-xs px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-semibold rounded transition"
            >
              Reactivate
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { setActionError(''); setDeactivateModalUser(row); }}
              className="text-xs px-2.5 py-1 bg-red-50 hover:bg-red-100 text-red-700 font-semibold rounded transition"
            >
              Deactivate
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="min-w-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900">Users</h1>
      </div>

      {actionError && (
        <div className="mb-4 p-3 bg-red-50 text-red-700 border border-red-200 rounded-lg text-sm" role="alert">
          {actionError}
        </div>
      )}

      {actionSuccess && (
        <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg text-sm">
          {actionSuccess}
        </div>
      )}

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

      {/* Onboarding Checkpoints Modal */}
      {onboardingUser && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 mb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Onboarding Status</h2>
                <p className="text-xs text-slate-500">{onboardingUser.phoneNumber}</p>
              </div>
              <button
                type="button"
                onClick={() => { setOnboardingUser(null); setOnboardingData(null); }}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold px-2"
              >
                ✕
              </button>
            </div>

            {onboardingLoading ? (
              <div className="flex justify-center py-10"><Loader /></div>
            ) : onboardingData ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                  <span className="text-sm font-medium text-slate-700">Stage: <strong className="capitalize">{onboardingData.stage}</strong></span>
                  <span className="text-sm font-bold text-primary">{onboardingData.percentComplete}% Complete</span>
                </div>

                {onboardingData.nextStep && (
                  <div className="p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-900">
                    <span className="font-semibold uppercase tracking-wider block mb-0.5">Next Required Step</span>
                    {onboardingData.nextStep.message}
                  </div>
                )}

                {onboardingData.blockers && onboardingData.blockers.length > 0 && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
                    <span className="font-semibold block mb-0.5">Active Blockers</span>
                    <ul className="list-disc list-inside">
                      {onboardingData.blockers.map((b, i) => <li key={i}>{b}</li>)}
                    </ul>
                  </div>
                )}

                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Checkpoints</h3>
                  {onboardingData.checkpoints?.map((cp) => (
                    <div key={cp.id} className="flex items-start justify-between p-2.5 border border-slate-100 rounded-lg text-xs">
                      <div>
                        <div className="font-medium text-slate-900">{cp.label}</div>
                        <div className="text-slate-500">{cp.description}</div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full font-semibold shrink-0 ml-2 ${
                        cp.complete ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
                      }`}>
                        {cp.complete ? 'Done' : 'Pending'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Deactivate User Modal */}
      {deactivateModalUser && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={handleDeactivate} className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <h2 className="text-lg font-bold text-red-900 mb-1">Deactivate Customer Account</h2>
            <p className="text-xs text-slate-600 mb-4">
              Disables wallet and payment operations for <strong>{deactivateModalUser.phoneNumber}</strong>.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Deactivation Reason *</label>
                <select
                  value={deactivateReason}
                  onChange={(e) => setDeactivateReason(e.target.value)}
                  className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:ring-2 focus:ring-red-500 outline-none"
                  required
                >
                  <option value="risk_score_exceeded">Risk Score Exceeded</option>
                  <option value="sanctions_match">Sanctions Match</option>
                  <option value="prolonged_inactivity">Prolonged Inactivity</option>
                  <option value="fraud_suspicion">Fraud Suspicion</option>
                  <option value="customer_request">Customer Request</option>
                  <option value="regulatory_order">Regulatory Order</option>
                  <option value="duplicate_account">Duplicate Account</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Operational Notes</label>
                <textarea
                  value={deactivateNotes}
                  onChange={(e) => setDeactivateNotes(e.target.value)}
                  placeholder="Detail context for compliance audit..."
                  className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:ring-2 focus:ring-red-500 outline-none h-20"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="forceDeact"
                  checked={deactivateForce}
                  onChange={(e) => setDeactivateForce(e.target.checked)}
                  className="rounded border-slate-300 text-red-600 focus:ring-red-500"
                />
                <label htmlFor="forceDeact" className="text-xs text-slate-700">
                  Force override (skip pending KYC warning)
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={() => setDeactivateModalUser(null)}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submittingAction}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition disabled:opacity-50"
              >
                {submittingAction ? 'Deactivating…' : 'Confirm Deactivation'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Reactivate User Modal */}
      {reactivateModalUser && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={handleReactivate} className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <h2 className="text-lg font-bold text-slate-900 mb-1">Reactivate Customer Account</h2>
            <p className="text-xs text-slate-600 mb-4">
              Restores wallet and payment operations for <strong>{reactivateModalUser.phoneNumber}</strong>.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Reactivation Notes *</label>
                <textarea
                  value={reactivateNotes}
                  onChange={(e) => setReactivateNotes(e.target.value)}
                  placeholder="State resolution rationale (e.g. Identity verified / False positive resolved)..."
                  className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:ring-2 focus:ring-primary outline-none h-20"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Second Approver ID (Maker-Checker)</label>
                <input
                  type="text"
                  value={reactivateApprovedBy}
                  onChange={(e) => setReactivateApprovedBy(e.target.value)}
                  placeholder="Optional second admin ID..."
                  className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:ring-2 focus:ring-primary outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={() => setReactivateModalUser(null)}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submittingAction}
                className="px-4 py-2 text-xs font-semibold text-white bg-primary hover:bg-emerald-600 rounded-lg transition disabled:opacity-50"
              >
                {submittingAction ? 'Reactivating…' : 'Confirm Reactivation'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
