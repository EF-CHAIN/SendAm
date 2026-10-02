import { useState, useEffect, useRef, useCallback } from 'react';
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
import PasskeyPromptModal, { usePasskeyStepUp } from '@/components/PasskeyPromptModal';

// Anything that can hold focus inside a dialog, in DOM order.
const FOCUSABLE_IN_DIALOG = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const focusableIn = (root) =>
  Array.from(root.querySelectorAll(FOCUSABLE_IN_DIALOG)).filter(
    (el) => !el.hasAttribute('aria-hidden') && el.tabIndex !== -1
  );

/**
 * Keyboard containment for a modal dialog (WCAG 2.2: 2.1.2 No Keyboard Trap
 * still needs a documented way out — Escape; 2.4.3 Focus Order — focus must
 * enter the dialog when it opens and return to the trigger when it closes).
 *
 * Returns a ref to attach to the dialog element. Tab and Shift+Tab cycle within
 * the dialog only, Escape invokes `onClose`, and the element focused before the
 * dialog opened is refocused on close.
 */
function useDialogFocusTrap(isOpen, onClose) {
  const dialogRef = useRef(null);
  const returnFocusRef = useRef(null);
  // onClose is a fresh closure every render; keeping it in a ref lets the effect
  // below depend on `isOpen` alone, so opening the dialog re-runs it once
  // instead of stealing focus on every subsequent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return undefined;

    returnFocusRef.current = document.activeElement;
    const items = focusableIn(dialog);
    (items[0] || dialog).focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableIn(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // When the dialog container itself holds focus, pull focus to the correct
      // end rather than letting the browser continue behind the dialog.
      if (active === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const trigger = returnFocusRef.current;
      if (trigger && document.contains(trigger) && typeof trigger.focus === 'function') {
        trigger.focus();
      }
    };
  }, [isOpen]);

  return dialogRef;
}

export default function Users() {
  const { params, getFilter, setFilter, resetFilters, goNext, goPrev } = useListQuery(['phone']);
  // High-risk actions on this page (deactivate / reactivate / evidence
  // download) are gated behind a WebAuthn passkey assertion. The hook only
  // invokes the mutation callback after the device prompt succeeds.
  const { startStepUp, stepUpModalProps } = usePasskeyStepUp();
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
  const [refreshKey, setRefreshKey] = useState(0);

  const closeOnboarding = useCallback(() => {
    setOnboardingUser(null);
    setOnboardingData(null);
  }, []);
  const closeDeactivate = useCallback(() => setDeactivateModalUser(null), []);
  const closeReactivate = useCallback(() => setReactivateModalUser(null), []);

  const onboardingDialogRef = useDialogFocusTrap(Boolean(onboardingUser), closeOnboarding);
  const deactivateDialogRef = useDialogFocusTrap(Boolean(deactivateModalUser), closeDeactivate);
  const reactivateDialogRef = useDialogFocusTrap(Boolean(reactivateModalUser), closeReactivate);

  useEffect(() => {
    let active = true;
    // Same fetch pattern as the other list pages: loading is toggled inside
    // the async fetch so the spinner shows on every refetch without calling
    // setState synchronously in the effect body (react-hooks/set-state-in-effect).
    const fetchUsers = async () => {
      setLoading(true);
      try {
        const res = await getAdminUsers(params);
        if (!active) return;
        setUsers(res.data || []);
        setPagination(res.pagination);
      } catch (err) {
        console.error(err);
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchUsers();
    return () => {
      active = false;
    };
  }, [params, refreshKey]);

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

  // Downloading a compliance evidence package is a high-risk export, so it is
  // intercepted by the passkey step-up before the request is issued.
  const handleDownloadEvidence = (userId) => {
    setActionError('');
    setActionSuccess('');
    startStepUp('user.evidence.download', async ({ passkeyAssertion, passkeyFallback }) => {
      try {
        await downloadUserEvidencePackage(userId, { passkeyAssertion, passkeyFallback });
        setActionSuccess('Compliance evidence package downloaded successfully.');
      } catch (err) {
        setActionError(err.response?.data?.message || 'Failed to export compliance evidence');
      }
    });
  };

  // Manual account deactivation is irreversible for the customer, so the
  // passkey challenge runs between the confirmation form and the mutation.
  const handleDeactivate = (e) => {
    e.preventDefault();
    if (!deactivateModalUser) return;
    const target = deactivateModalUser;
    const payload = {
      reason: deactivateReason,
      notes: deactivateNotes,
      force: deactivateForce,
    };
    startStepUp('user.deactivate', async ({ passkeyAssertion, passkeyFallback }) => {
      setSubmittingAction(true);
      setActionError('');
      try {
        await deactivateUserAccount(target.id, {
          ...payload,
          passkeyAssertion,
          passkeyFallback,
        });
        setDeactivateModalUser(null);
        setDeactivateNotes('');
        setActionSuccess('Account deactivated successfully.');
        setRefreshKey((k) => k + 1);
      } catch (err) {
        setActionError(err.response?.data?.message || err.message || 'Failed to deactivate account');
      } finally {
        setSubmittingAction(false);
      }
    });
  };

  const handleReactivate = (e) => {
    e.preventDefault();
    if (!reactivateModalUser) return;
    const target = reactivateModalUser;
    const payload = {
      notes: reactivateNotes,
      approvedBy: reactivateApprovedBy || undefined,
    };
    startStepUp('user.reactivate', async ({ passkeyAssertion, passkeyFallback }) => {
      setSubmittingAction(true);
      setActionError('');
      try {
        await reactivateUserAccount(target.id, {
          ...payload,
          passkeyAssertion,
          passkeyFallback,
        });
        setReactivateModalUser(null);
        setReactivateNotes('');
        setReactivateApprovedBy('');
        setActionSuccess('Account reactivated successfully.');
        setRefreshKey((k) => k + 1);
      } catch (err) {
        setActionError(err.response?.data?.message || err.message || 'Failed to reactivate account');
      } finally {
        setSubmittingAction(false);
      }
    });
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
        <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg text-sm" role="status">
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
          <DataTable caption="Users" columns={columns} data={users} keyField="_id" />
          <Pagination pagination={pagination} onNext={goNext} onPrev={goPrev} />
        </>
      )}

      {/* Onboarding Checkpoints Modal */}
      {onboardingUser && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div
            ref={onboardingDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-status-dialog-title"
            tabIndex={-1}
            className="bg-white dark:bg-slate-900 rounded-2xl max-w-lg w-full p-6 shadow-xl max-h-[90vh] overflow-y-auto border border-gray-100 dark:border-slate-800"
          >
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800 mb-4">
              <div>
                <h2 id="onboarding-status-dialog-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">Onboarding Status</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">{onboardingUser.phoneNumber}</p>
              </div>
              <button
                type="button"
                onClick={closeOnboarding}
                aria-label="Close onboarding status"
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg font-bold px-2"
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
          <form
            ref={deactivateDialogRef}
            onSubmit={handleDeactivate}
            role="dialog"
            aria-modal="true"
            aria-labelledby="deactivate-user-dialog-title"
            tabIndex={-1}
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl"
          >
            <h2 id="deactivate-user-dialog-title" className="text-lg font-bold text-red-900 mb-1">Deactivate Customer Account</h2>
            <p className="text-xs text-slate-600 mb-4">
              Disables wallet and payment operations for <strong>{deactivateModalUser.phoneNumber}</strong>.
            </p>

            <div className="space-y-4">
              <div>
                <label htmlFor="deactivate-reason" className="block text-xs font-medium text-slate-700 mb-1">Deactivation Reason *</label>
                <select
                  id="deactivate-reason"
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
                <label htmlFor="deactivate-notes" className="block text-xs font-medium text-slate-700 mb-1">Operational Notes</label>
                <textarea
                  id="deactivate-notes"
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

            <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Passkey verification is required. You will confirm with your device biometrics or
              security key before this deactivation is submitted.
            </p>

            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={closeDeactivate}
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
          <form
            ref={reactivateDialogRef}
            onSubmit={handleReactivate}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reactivate-user-dialog-title"
            tabIndex={-1}
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl"
          >
            <h2 id="reactivate-user-dialog-title" className="text-lg font-bold text-slate-900 mb-1">Reactivate Customer Account</h2>
            <p className="text-xs text-slate-600 mb-4">
              Restores wallet and payment operations for <strong>{reactivateModalUser.phoneNumber}</strong>.
            </p>

            <div className="space-y-4">
              <div>
                <label htmlFor="reactivate-notes" className="block text-xs font-medium text-slate-700 mb-1">Reactivation Notes *</label>
                <textarea
                  id="reactivate-notes"
                  value={reactivateNotes}
                  onChange={(e) => setReactivateNotes(e.target.value)}
                  placeholder="State resolution rationale (e.g. Identity verified / False positive resolved)..."
                  className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:ring-2 focus:ring-primary outline-none h-20"
                  required
                />
              </div>

              <div>
                <label htmlFor="reactivate-approved-by" className="block text-xs font-medium text-slate-700 mb-1">Second Approver ID (Maker-Checker)</label>
                <input
                  id="reactivate-approved-by"
                  type="text"
                  value={reactivateApprovedBy}
                  onChange={(e) => setReactivateApprovedBy(e.target.value)}
                  placeholder="Optional second admin ID..."
                  className="w-full text-sm rounded-lg border border-slate-300 p-2 focus:ring-2 focus:ring-primary outline-none"
                />
              </div>
            </div>

            <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Passkey verification is required. You will confirm with your device biometrics or
              security key before this reactivation is submitted.
            </p>

            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={closeReactivate}
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

      {/* WebAuthn / passkey step-up prompt for high-risk actions */}
      <PasskeyPromptModal {...stepUpModalProps} />
    </div>
  );
}
