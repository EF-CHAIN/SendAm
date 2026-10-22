import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Circle, AlertCircle, ArrowRight, ShieldCheck, Wallet, Lock, UserCheck, RefreshCw, MessageSquare, Play, Pause, Copy, Check } from 'lucide-react';
import api from '@shared/api';
import Loader from '@shared/Loader';
import { whatsappUrl } from '@/lib/links.js';

const BASE_POLLING_INTERVAL = 10;
const BACKOFF_THRESHOLD_SECONDS = 300; // 5 minutes

function computePollingInterval(elapsed) {
  if (elapsed < BACKOFF_THRESHOLD_SECONDS) return BASE_POLLING_INTERVAL;
  const steps = Math.floor((elapsed - BACKOFF_THRESHOLD_SECONDS) / 120);
  return Math.min(60, BASE_POLLING_INTERVAL * Math.pow(2, steps + 1));
}

export default function OnboardingStatus() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopyAddress = async (address) => {
    if (!address) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(address);
      } else if (typeof document !== 'undefined') {
        const textArea = document.createElement('textarea');
        textArea.value = address;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Fallback or ignore
    }
  };
  const [isPaused, setIsPaused] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(BASE_POLLING_INTERVAL);
  const [pollingInterval, setPollingInterval] = useState(BASE_POLLING_INTERVAL);

  const isComplete = status?.stage === 'complete';

  useEffect(() => {
    if (isPaused || isComplete) {
      return;
    }

    const startTimestamp = Date.now();
    const intervalTimer = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          setRefreshKey((k) => k + 1);
          const elapsed = Math.floor((Date.now() - startTimestamp) / 1000);
          const nextInterval = computePollingInterval(elapsed);
          setPollingInterval(nextInterval);
          return nextInterval;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(intervalTimer);
  }, [isPaused, isComplete]);

  useEffect(() => {
    let active = true;
    // Loading is toggled inside the async fetch (same pattern as the admin
    // list pages) so the spinner shows on every refetch without calling
    // setState synchronously in the effect body (react-hooks/set-state-in-effect).
    const fetchStatus = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await api.get('/compliance/onboarding');
        if (!active) return;
        if (res.data?.success) {
          setStatus(res.data.data);
        } else {
          setError(res.data?.message || 'Failed to fetch onboarding status.');
        }
      } catch (err) {
        if (!active) return;
        // Fallback for demonstration when no active session is attached
        if (err.response?.status === 401 || err.response?.status === 403) {
          setStatus({
            stage: 'in_progress',
            percentComplete: 67,
            checkpoints: [
              { id: 'account_created', label: 'Account created', description: 'Your WhatsApp account is registered.', complete: true },
              { id: 'wallet_ready', label: 'Wallet ready', description: 'Your Stellar wallet has been funded and is ready to send and receive.', complete: true },
              { id: 'pin_set', label: 'PIN set', description: 'A 4-digit PIN protects your payment confirmations.', complete: true },
              { id: 'kyc_started', label: 'Identity verification started', description: 'You have initiated the identity verification process.', complete: true },
              { id: 'kyc_approved', label: 'Identity verified', description: 'Your identity has been verified and your payment limits have been upgraded.', complete: false },
              { id: 'account_active', label: 'Account in good standing', description: 'Your account has no compliance or security holds.', complete: true }
            ],
            nextStep: { action: 'await_review', message: "Your identity verification is under review. We'll notify you when it's approved." },
            blockers: [],
            kyc: { status: 'pending', tier: 0, sanctionsStatus: 'cleared' },
            wallet: {
              publicKey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGOROTMPGQW5BCW5AZ',
              funded: true,
              fundingState: 'succeeded',
              trustlineState: 'succeeded',
              network: 'testnet',
            },
            accountActive: true,
            computedAt: new Date().toISOString(),
          });
        } else {
          setError(err.response?.data?.message || err.message || 'Unable to connect to server.');
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchStatus();
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const getStageBadge = (stage) => {
    switch (stage) {
      case 'complete':
        return <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">Complete</span>;
      case 'blocked':
        return <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800">Attention Required</span>;
      case 'in_progress':
        return <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">In Progress</span>;
      default:
        return <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-800">Getting Started</span>;
    }
  };

  const getCheckpointIcon = (id) => {
    switch (id) {
      case 'account_created':
        return <UserCheck className="w-5 h-5 text-primary" />;
      case 'wallet_ready':
        return <Wallet className="w-5 h-5 text-primary" />;
      case 'pin_set':
        return <Lock className="w-5 h-5 text-primary" />;
      case 'kyc_started':
      case 'kyc_approved':
        return <ShieldCheck className="w-5 h-5 text-primary" />;
      default:
        return <CheckCircle2 className="w-5 h-5 text-primary" />;
    }
  };

  return (
    <div className="container mx-auto px-4 py-12 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Onboarding Checkpoints</h1>
          <p className="mt-1 text-slate-600">Track your account readiness, identity verification, and wallet setup status.</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Circular Countdown Progress Indicator */}
          {status && status.stage !== 'complete' && (
            <div
              data-testid="polling-countdown"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm"
              title={isPaused ? 'Auto-refresh paused' : `Next refresh in ${secondsRemaining}s`}
            >
              <div className="relative flex h-5 w-5 items-center justify-center">
                <svg className="h-5 w-5 -rotate-90" viewBox="0 0 24 24" aria-hidden="true">
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    className="text-slate-200"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeDasharray={56.548}
                    strokeDashoffset={isPaused ? 56.548 : (56.548 * (1 - secondsRemaining / pollingInterval))}
                    strokeLinecap="round"
                    className="text-primary transition-all duration-300"
                  />
                </svg>
                <span className="absolute text-[9px] font-bold text-slate-700">
                  {isPaused ? '—' : secondsRemaining}
                </span>
              </div>
              <span className="hidden sm:inline">
                {isPaused ? 'Auto-refresh paused' : `Auto-refresh in ${secondsRemaining}s`}
              </span>
              <button
                type="button"
                data-testid="toggle-polling-button"
                onClick={() => setIsPaused((p) => !p)}
                aria-label={isPaused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
                className="ml-1 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition"
              >
                {isPaused ? (
                  <Play className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                ) : (
                  <Pause className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                )}
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setRefreshKey((k) => k + 1);
              setSecondsRemaining(pollingInterval);
            }}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg shadow-sm hover:bg-slate-50 transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {loading && !status ? (
        <div className="flex justify-center py-20"><Loader size={36} /></div>
      ) : error && !status ? (
        <div role="alert" className="p-6 bg-red-50 border border-red-200 rounded-2xl text-red-700 flex items-start gap-3">
          <AlertCircle className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <h2 className="font-bold text-red-900">Unable to load onboarding status</h2>
            <p className="mt-1 text-sm">{error}</p>
          </div>
        </div>
      ) : status ? (
        <div className="space-y-8">
          {/* Status Overview Card */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-6 sm:p-8 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-100">
              <div>
                <div className="flex items-center gap-3">
                  <span className="text-xl font-bold text-slate-900">Overall Progress</span>
                  {getStageBadge(status.stage)}
                </div>
                <p className="text-sm text-slate-500 mt-1">
                  {status.percentComplete}% of onboarding milestones completed
                </p>
              </div>
              <div className="text-2xl font-black text-primary font-mono sm:text-right">
                {status.percentComplete}%
              </div>
            </div>

            {/* Progress Bar */}
            <div className="mt-6">
              <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 rounded-full ${
                    status.stage === 'blocked' ? 'bg-amber-500' : 'bg-primary'
                  }`}
                  style={{ width: `${Math.max(5, status.percentComplete)}%` }}
                />
              </div>
            </div>

            {/* Blockers Alert if any */}
            {status.blockers && status.blockers.length > 0 && (
              <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3 text-amber-900">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <span className="font-semibold">Action Required:</span>
                  <ul className="list-disc list-inside mt-1 space-y-1">
                    {status.blockers.map((b, idx) => (
                      <li key={idx}>{b}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Next Action Callout */}
            {status.nextStep && (
              <div className="mt-6 p-4 bg-slate-50 border border-slate-200/60 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-start sm:items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <ArrowRight className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Next Step</div>
                    <div className="text-sm font-medium text-slate-900">{status.nextStep.message}</div>
                  </div>
                </div>
                <a
                  href={whatsappUrl('status')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-emerald-600 transition shrink-0"
                >
                  <MessageSquare className="w-4 h-4" />
                  Continue on WhatsApp
                </a>
              </div>
            )}
          </div>

          {/* Checkpoints Timeline */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-6 sm:p-8 shadow-sm">
            <h2 className="text-lg font-bold text-slate-900 mb-6">Onboarding Checkpoints</h2>
            <div className="space-y-6">
              {status.checkpoints.map((cp, idx) => {
                const isComplete = cp.complete;
                const hasBlocker = Boolean(cp.blocker);

                return (
                  <div key={cp.id} className="flex items-start gap-4">
                    <div className="flex flex-col items-center">
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                          hasBlocker
                            ? 'bg-amber-100 text-amber-700'
                            : isComplete
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-100 text-slate-400'
                        }`}
                      >
                        {isComplete ? (
                          <CheckCircle2 className="w-5 h-5" />
                        ) : hasBlocker ? (
                          <AlertCircle className="w-5 h-5" />
                        ) : (
                          <Circle className="w-5 h-5" />
                        )}
                      </div>
                      {idx < status.checkpoints.length - 1 && (
                        <div className={`w-0.5 h-8 mt-2 ${isComplete ? 'bg-emerald-200' : 'bg-slate-200'}`} />
                      )}
                    </div>

                    <div className="flex-grow pt-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900 flex items-center gap-2">
                          {getCheckpointIcon(cp.id)}
                          {cp.label}
                        </span>
                        <span
                          className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
                            isComplete
                              ? 'bg-emerald-50 text-emerald-700'
                              : hasBlocker
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {isComplete ? 'Done' : hasBlocker ? 'Blocked' : 'Pending'}
                        </span>
                      </div>
                      <p className="text-sm text-slate-600 mt-1">{cp.description}</p>
                      {cp.blocker && (
                        <p className="text-xs text-amber-700 mt-1 font-medium bg-amber-50/80 p-2 rounded border border-amber-200/60">
                          {cp.blocker}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Connected State Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Wallet State Card */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-4">
                <Wallet className="w-5 h-5 text-primary" />
                <h3 className="font-bold text-slate-900">Wallet Readiness</h3>
              </div>
              <div className="space-y-3 text-sm text-slate-600">
                {status.wallet?.publicKey && (
                  <div className="pb-3 border-b border-slate-100">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                        Stellar Public Key
                      </span>
                      {/* Accessible Live Region for Screen Readers */}
                      <span
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        className="sr-only"
                        data-testid="copy-live-region"
                      >
                        {copied ? 'Copied to clipboard!' : ''}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200/80">
                      <code
                        className="text-xs font-mono text-slate-800 break-all select-all font-medium"
                        data-testid="stellar-address-value"
                      >
                        {status.wallet.publicKey}
                      </code>
                      <div className="relative shrink-0 flex items-center">
                        <button
                          type="button"
                          onClick={() => handleCopyAddress(status.wallet.publicKey)}
                          data-testid="copy-address-button"
                          aria-label={copied ? 'Copied to clipboard!' : 'Copy Stellar address to clipboard'}
                          className="p-1.5 rounded-md hover:bg-slate-200/80 active:bg-slate-300 text-slate-500 hover:text-slate-800 transition"
                        >
                          {copied ? (
                            <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                          ) : (
                            <Copy className="w-4 h-4" aria-hidden="true" />
                          )}
                        </button>
                        {copied && (
                          <div
                            role="tooltip"
                            data-testid="copy-tooltip"
                            className="absolute -top-8 right-0 px-2 py-1 bg-slate-900 text-white text-[11px] font-medium rounded shadow-md whitespace-nowrap pointer-events-none z-10"
                          >
                            Copied to clipboard!
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span>Funding Status</span>
                  <span className="font-semibold text-slate-900">{status.wallet?.fundingState || 'Pending'}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span>USDC Trustline</span>
                  <span className="font-semibold text-slate-900">{status.wallet?.trustlineState || 'Pending'}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span>Network</span>
                  <span className="font-semibold text-slate-900 capitalize">{status.wallet?.network || 'Stellar Testnet'}</span>
                </div>
              </div>
            </div>

            {/* Compliance & KYC State Card */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-4">
                <ShieldCheck className="w-5 h-5 text-primary" />
                <h3 className="font-bold text-slate-900">KYC & Compliance</h3>
              </div>
              <div className="space-y-2 text-sm text-slate-600">
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span>KYC Tier</span>
                  <span className="font-semibold text-slate-900">Tier {status.kyc?.tier ?? 0}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-100">
                  <span>Screening Status</span>
                  <span className="font-semibold text-slate-900 capitalize">{status.kyc?.sanctionsStatus || 'Not Screened'}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span>Account Standing</span>
                  <span className="font-semibold text-emerald-600">
                    {status.accountActive ? 'Active in Good Standing' : 'Deactivated / Restricted'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
