import { useState, useEffect } from 'react';
import {
  getAdminKyc,
  approveKyc,
  rejectKyc,
  fetchAdminKycExportData,
  exportAdminKyc,
} from '@/lib/adminApi';
import { useListQuery } from '@/lib/useListQuery';
import DataTable from '@/components/DataTable';
import StatusBadge from '@/components/StatusBadge';
import Loader from '@shared/Loader';
import Pagination from '@/components/Pagination';
import FilterBar from '@/components/FilterBar';
import KycExportModal from '@/components/KycExportModal';
import KycImageCompareModal from '@/components/KycImageCompareModal';
import { encryptData, downloadEncryptedFile } from '@/lib/clientCrypto';
import { REJECTION_REASONS } from '@/lib/rejectionReasons';
import PasskeyPromptModal, { usePasskeyStepUp } from '@/components/PasskeyPromptModal';
import { Clock, User, ChevronDown, ChevronUp } from 'lucide-react';

export { REJECTION_REASONS };

// Customer-facing preset rejection phrases (#760). Operators tap a tag to drop
// it into the explanation textarea instead of typing the same wording by hand;
// each tag toggles so a phrase can also be removed with one click.
const REJECTION_TAGS = ['Blurry Document', 'Expired ID', 'Name Mismatch', 'Selfie Mismatch'];

// A rejection needs a structured reason code *and* a customer explanation:
// at least one preset tag or at least this many characters of free text.
const MIN_EXPLANATION_LENGTH = 20;

export default function KycReview() {
  const { params, getFilter, setFilter, resetFilters, goNext, goPrev } =
    useListQuery(['status', 'phone', 'country']);
  // Approve / reject / export are all high-risk compliance decisions, so each
  // mutation is gated behind a WebAuthn passkey assertion.
  const { startStepUp, stepUpModalProps } = usePasskeyStepUp();

  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [timelineRow, setTimelineRow] = useState(null);
  const [mutatingId, setMutatingId] = useState(null);

  // Side-by-side comparison modal state
  const [compareTarget, setCompareTarget] = useState(null);

  // Confirmation modal state. `confirmTarget` holds the row awaiting an
  // explicit operator confirmation; `confirmAction` is 'approve' | 'reject'.
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [rejectionNotes, setRejectionNotes] = useState('');

  useEffect(() => {
    let active = true;
    const fetchKyc = async () => {
      setLoading(true);
      try {
        const res = await getAdminKyc(params);
        if (active) {
          setRows(res.data || []);
          setPagination(res.pagination);
        }
      } catch (err) {
        if (active) setError(err.message || 'Failed to fetch KYC profiles');
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchKyc();
    return () => {
      active = false;
    };
  }, [params, refreshKey]);

  const handleApprove = async (id, stepUp = {}) => {
    setMutatingId(id);
    setError('');
    try {
      await approveKyc(id, stepUp);
      setRows((prev) =>
        prev.map((r) => (r._id === id ? { ...r, status: 'approved' } : r))
      );
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to approve KYC');
    } finally {
      setMutatingId(null);
    }
  };

  const handleReject = async (id, reason, stepUp = {}) => {
    setMutatingId(id);
    setError('');
    try {
      await rejectKyc(id, reason, stepUp);
      setRows((prev) =>
        prev.map((r) => (r._id === id ? { ...r, status: 'rejected' } : r))
      );
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to reject KYC');
    } finally {
      setMutatingId(null);
    }
  };

  const openConfirm = (row, action) => {
    setError('');
    setConfirmTarget(row);
    setConfirmAction(action);
    setRejectionReason('');
    setRejectionNotes('');
  };

  const closeConfirm = () => {
    setConfirmTarget(null);
    setConfirmAction(null);
    setRejectionReason('');
    setRejectionNotes('');
  };

  const rejectionExplanation = rejectionNotes.trim();
  const hasPresetTag = REJECTION_TAGS.some((label) => rejectionExplanation.includes(label));
  const rejectionReasonValid =
    rejectionReason !== '' &&
    (hasPresetTag || rejectionExplanation.length >= MIN_EXPLANATION_LENGTH);

  const toggleRejectionTag = (label) => {
    setRejectionNotes((prev) => {
      if (prev.includes(label)) {
        return prev
          .replace(new RegExp(`\\s*${label}\\.?`), '')
          .replace(/\s{2,}/g, ' ')
          .trim();
      }
      const base = prev.trim();
      return base ? `${base} ${label}.` : `${label}.`;
    });
  };

  const handleConfirmSubmit = (event) => {
    event.preventDefault();
    if (!confirmTarget) return;
    const id = confirmTarget._id;
    if (confirmAction === 'approve') {
      closeConfirm();
      startStepUp('kyc.approve', (stepUp) => handleApprove(id, stepUp));
      return;
    }
    if (!rejectionReasonValid) return;
    const reason = rejectionNotes.trim()
      ? `${rejectionReason}: ${rejectionNotes.trim()}`
      : rejectionReason;
    closeConfirm();
    startStepUp('kyc.reject', (stepUp) => handleReject(id, reason, stepUp));
  };

  const handleExportSubmit = async ({ format, passphrase }) => {
    setExporting(true);
    setError('');
    try {
      if (format === 'encrypted') {
        const rawBlob = await fetchAdminKycExportData(params);
        const textContent = await rawBlob.text();
        const encrypted = await encryptData(textContent, passphrase, {
          filters: params,
          exportedAt: new Date().toISOString(),
          dataType: 'KYC_EXPORT',
        });
        downloadEncryptedFile(encrypted, `kyc-export-${Date.now()}.sendam-enc`);
      } else {
        await exportAdminKyc(params);
      }
      setExportModalOpen(false);
    } catch (err) {
      setError(
        err.response?.data?.message || err.message || 'Failed to export KYC'
      );
    } finally {
      setExporting(false);
    }
  };

  const handleRefresh = () => setRefreshKey((prev) => prev + 1);

  if (loading)
    return (
      <div className="flex justify-center py-20" data-testid="kyc-loading">
        <Loader size={32} />
      </div>
    );

  const columns = [
    { header: 'User', render: (row) => row.userId?.phoneNumber || '-' },
    { header: 'Provider', accessor: 'provider' },
    { header: 'Tier', accessor: 'tier' },
    { header: 'Risk', accessor: 'riskScore' },
    { header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      header: 'Updated',
      render: (row) => new Date(row.updatedAt).toLocaleString(),
    },
    {
      header: 'Actions',
      render: (row) => (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setCompareTarget(row)}
            className="px-2.5 py-1 text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 rounded border border-slate-300 dark:border-slate-700 font-medium transition"
            data-testid={`compare-btn-${row._id}`}
            aria-label={`Compare documents for ${row.userId?.phoneNumber || row._id}`}
          >
            Compare
          </button>
          {['pending', 'review'].includes(row.status) && (
            <>
              <button
                onClick={() => openConfirm(row, 'approve')}
                disabled={mutatingId === row._id}
                className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() => openConfirm(row, 'reject')}
                disabled={mutatingId === row._id}
                className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  const renderTimelineEvents = (row) => {
    const history = row.reviewHistory || row.reviewEvents || [];
    const sorted = [...history].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (sorted.length === 0) return null;
    return sorted.map((event, idx) => (
      <div key={idx} className="flex items-start gap-3 pl-4 border-l-2 border-l-gray-200 dark:border-l-slate-700">
        <div className="mt-1 w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500" />
        <div className="flex-1">
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="font-semibold text-sm text-gray-900 dark:text-gray-100">
              {event.reviewerName || event.reviewer?.username || 'Unknown reviewer'}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(event.createdAt || event.timestamp).toLocaleString()}
            </span>
          </div>
          {event.previousStatus && event.newStatus && (
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-gray-500">Status:</span>
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{event.previousStatus}</span>
              <span className="text-xs text-gray-400">→</span>
              <span className={`text-xs font-medium ${event.newStatus === 'approved' ? 'text-green-700' : event.newStatus === 'rejected' ? 'text-red-700' : 'text-blue-700'}`}>
                {event.newStatus}
              </span>
            </div>
          )}
          {event.internalComments && (
            <p className="text-xs text-gray-700 dark:text-gray-300 italic">{event.internalComments}</p>
          )}
        </div>
      </div>
    ));
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">KYC Review</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50 disabled:opacity-50"
            data-testid="refresh-kyc"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setExportModalOpen(true)}
            disabled={exporting}
            className="text-sm rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium shadow-sm hover:bg-gray-50 disabled:opacity-50"
            data-testid="export-kyc"
          >
            {exporting ? 'Exporting…' : 'Export KYC'}
          </button>
        </div>
      </div>

      <FilterBar
        fields={[
          {
            key: 'status',
            label: 'Status',
            type: 'select',
            options: [
              'not_started',
              'pending',
              'review',
              'approved',
              'rejected',
            ],
          },
          { key: 'phone', label: 'Phone', placeholder: 'Search phone…' },
          { key: 'country', label: 'Country', placeholder: 'e.g. NG' },
        ]}
        getFilter={getFilter}
        setFilter={setFilter}
        onReset={resetFilters}
      />

      {error && (
        <div
          className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded"
          role="alert"
        >
          {error}
        </div>
      )}
      <DataTable caption="KYC review submissions" columns={columns} data={rows} keyField="_id" onRowClick={(row) => setTimelineRow((prev) => (prev?._id === row._id ? null : row))} />

      {timelineRow && (
        <div className="mb-6 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 cursor-pointer" onClick={() => setTimelineRow(null)}>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-600 dark:text-gray-400" />
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Review timeline for {timelineRow.userId?.phoneNumber}</span>
            </div>
            <ChevronUp className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          </div>
          <div className="p-4 space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 space-y-4">
                {renderTimelineEvents(timelineRow)}
              </div>
            </div>
            {!timelineRow.reviewHistory?.length && (
              <p className="text-xs text-gray-500 text-center py-4">No review history recorded for this KYC application.</p>
            )}
          </div>
        </div>
      )}

      <Pagination pagination={pagination} onNext={goNext} onPrev={goPrev} />

      {/* Approve / Reject confirmation modal */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmSubmit}
            role="dialog"
            aria-modal="true"
            aria-labelledby="kyc-confirm-title"
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl"
          >
            <h2
              id="kyc-confirm-title"
              className={`text-lg font-bold mb-1 ${confirmAction === 'reject' ? 'text-red-900' : 'text-slate-900'}`}
            >
              {confirmAction === 'reject' ? 'Reject KYC' : 'Approve KYC'}
            </h2>
            <p className="text-xs text-slate-600 mb-4">
              {confirmAction === 'reject'
                ? 'This will reject the KYC record for the customer below. A reason is required for the compliance audit trail.'
                : 'This will approve the KYC record for the customer below.'}
            </p>

            <dl className="mb-4 space-y-1 text-xs text-slate-700">
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-slate-500">Phone</dt>
                <dd data-testid="confirm-phone">{confirmTarget.userId?.phoneNumber || '-'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-slate-500">Risk Score</dt>
                <dd data-testid="confirm-risk">{confirmTarget.riskScore ?? '-'}</dd>
              </div>
            </dl>

            {confirmAction === 'reject' && (
              <div className="space-y-4">
                <div>
                  <label htmlFor="kycRejectionReason" className="block text-xs font-medium text-slate-700 mb-1">
                    Rejection Reason *
                  </label>
                  <select
                    id="kycRejectionReason"
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:ring-2 focus:ring-red-500 outline-none"
                    required
                  >
                    <option value="">Select a reason…</option>
                    {REJECTION_REASONS.map((reason) => (
                      <option key={reason.code} value={reason.code}>{reason.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <span
                    id="kyc-rejection-tags-label"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Common Reasons
                  </span>
                  <div
                    role="group"
                    aria-labelledby="kyc-rejection-tags-label"
                    className="flex flex-wrap gap-2"
                    data-testid="rejection-tags"
                  >
                    {REJECTION_TAGS.map((label) => {
                      const active = rejectionNotes.includes(label);
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => toggleRejectionTag(label)}
                          aria-pressed={active}
                          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-red-400 ${
                            active
                              ? 'border-red-500 bg-red-50 text-red-700'
                              : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                          }`}
                          data-testid={`rejection-tag-${label.toLowerCase().replace(/\s+/g, '-')}`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label htmlFor="kycRejectionNotes" className="block text-xs font-medium text-slate-700 mb-1">
                    Customer Explanation *
                  </label>
                  <textarea
                    id="kycRejectionNotes"
                    value={rejectionNotes}
                    onChange={(e) => setRejectionNotes(e.target.value)}
                    placeholder="Why was this submission rejected? Preset tags fill this in for you."
                    aria-describedby="kyc-explanation-hint"
                    className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:ring-2 focus:ring-red-500 outline-none h-20"
                    required
                  />
                  <p id="kyc-explanation-hint" className="mt-1 text-xs text-slate-500">
                    Select at least one preset tag or write at least {MIN_EXPLANATION_LENGTH}{' '}
                    characters — this text is shown to the customer.
                  </p>
                </div>
              </div>
            )}

            <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Passkey verification is required. You will confirm with your device biometrics or
              security key after submitting.
            </p>

            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={closeConfirm}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  mutatingId === confirmTarget._id ||
                  (confirmAction === 'reject' && !rejectionReasonValid)
                }
                className={`px-4 py-2 text-xs font-semibold text-white rounded-lg transition disabled:opacity-50 ${
                  confirmAction === 'reject'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-green-600 hover:bg-green-700'
                }`}
              >
                {confirmAction === 'reject' ? 'Confirm Rejection' : 'Confirm Approval'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* WebAuthn / passkey step-up prompt for high-risk compliance actions */}
      <PasskeyPromptModal {...stepUpModalProps} />

      <KycExportModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        onExport={handleExportSubmit}
        exporting={exporting}
      />

      {/* Side-by-side Document vs Selfie Liveness Comparison Modal */}
      <KycImageCompareModal
        key={compareTarget?._id || 'none'}
        isOpen={Boolean(compareTarget)}
        onClose={() => setCompareTarget(null)}
        record={compareTarget}
        onApprove={(row) => openConfirm(row, 'approve')}
        onReject={(row) => openConfirm(row, 'reject')}
      />
    </div>
  );
}
