import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Fingerprint } from 'lucide-react';
import {
  STEP_UP_FALLBACK_UNSUPPORTED,
  describeWebAuthnError,
  getActionMeta,
  getStepUpSupport,
  performStepUp,
} from '@/lib/webauthn';
import { getPasskeyStepUpChallenge } from '@/lib/adminApi';

// Modal that explains and drives the WebAuthn step-up prompt for a sensitive
// admin action. Rendered by `usePasskeyStepUp()`; see `Users.jsx` /
// `KycReview.jsx` for the interception points.
//
// Two paths are exposed:
//   * supported devices  -> "Verify with passkey" runs the assertion
//   * unsupported devices -> an explicit, acknowledged fallback so an operator
//     on old hardware is never locked out, but the operation is clearly
//     recorded as having no biometric signature.
export default function PasskeyPromptModal({
  open = false,
  action,
  status = 'idle',
  error = '',
  support,
  fallbackAcknowledged = false,
  onFallbackAcknowledgedChange,
  onVerify,
  onFallback,
  onCancel,
}) {
  const meta = useMemo(() => getActionMeta(action), [action]);
  const primaryRef = useRef(null);
  const supported = support?.supported !== false;
  const verifying = status === 'verifying';
  // Until capability detection resolves we optimistically show the passkey
  // prompt rather than flashing the "unsupported device" fallback.
  const capabilityResolved = Boolean(support?.checked);
  const showFallback = !supported;

  useEffect(() => {
    if (!open) return;
    primaryRef.current?.focus();
  }, [open, showFallback]);

  if (!open) return null;

  const handleKeyDown = (event) => {
    if (event.key === 'Escape' && !verifying) {
      event.stopPropagation();
      onCancel?.();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="passkey-prompt-title"
        aria-describedby="passkey-prompt-description"
        aria-busy={verifying}
        data-testid="passkey-prompt"
        className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl"
      >
        <div className="flex items-start gap-3">
          <div className="shrink-0 p-2.5 rounded-full bg-secondary text-primary" aria-hidden="true">
            <Fingerprint size={22} />
          </div>
          <div className="min-w-0">
            <h2 id="passkey-prompt-title" className="text-lg font-bold text-slate-900">
              Biometric step-up required
            </h2>
            <p id="passkey-prompt-description" className="mt-1 text-xs text-slate-600">
              {meta.description}
            </p>
          </div>
        </div>

        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <span className="font-semibold uppercase tracking-wider text-slate-500">Action</span>
          <span className="mt-0.5 block">{meta.label}</span>
        </p>

        {showFallback ? (
          <div className="mt-4 space-y-3">
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              This browser or device does not expose WebAuthn, so a biometric passkey cannot be
              requested here. You can continue, but the operation will be recorded without a
              passkey signature for the compliance audit trail.
            </p>
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                id="passkey-fallback-ack"
                checked={fallbackAcknowledged}
                onChange={(event) => onFallbackAcknowledgedChange?.(event.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-primary focus:ring-primary"
              />
              <label htmlFor="passkey-fallback-ack" className="text-xs text-slate-700">
                I understand this action will proceed without biometric verification.
              </label>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-slate-600">
              Use Touch ID, Face ID, Windows Hello, or a hardware security key to confirm. The
              signed assertion is attached to the request and verified by the API.
            </p>
            {capabilityResolved && support?.platformAuthenticator === false && (
              <p className="text-xs text-slate-500">
                No built-in biometric sensor was detected on this device — a hardware security key
                (e.g. YubiKey) also works.
              </p>
            )}
            {verifying && (
              <p role="status" className="text-xs font-medium text-primary">
                Waiting for your device…
              </p>
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => onCancel?.()}
            disabled={verifying}
            className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition disabled:opacity-50"
          >
            Cancel
          </button>
          {showFallback ? (
            <button
              ref={primaryRef}
              type="button"
              onClick={() => onFallback?.()}
              disabled={!fallbackAcknowledged || verifying}
              className="px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition disabled:opacity-50"
            >
              Continue without passkey
            </button>
          ) : (
            <button
              ref={primaryRef}
              type="button"
              onClick={() => onVerify?.()}
              disabled={verifying}
              className="px-4 py-2 text-xs font-semibold text-white bg-primary hover:bg-emerald-600 rounded-lg transition disabled:opacity-50"
            >
              {verifying ? 'Waiting for device…' : 'Verify with passkey'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Orchestrates the whole step-up flow for a page:
//
//   const { startStepUp, stepUpModalProps } = usePasskeyStepUp();
//   <button onClick={() => startStepUp('user.deactivate', runMutation)} />
//   ...
//   <PasskeyPromptModal {...stepUpModalProps} />
//
// `runMutation` receives `{ passkeyAssertion, passkeyFallback }` and is only
// invoked after the device prompt succeeds (or the fallback is acknowledged),
// so the API is never called with an unsigned high-risk request.
// eslint-disable-next-line react-refresh/only-export-components -- hook is intentionally co-located with the modal it drives
export function usePasskeyStepUp({ fetchChallenge = getPasskeyStepUpChallenge } = {}) {
  const [request, setRequest] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [fallbackAcknowledged, setFallbackAcknowledged] = useState(false);
  const [support, setSupport] = useState({ supported: true, platformAuthenticator: false, checked: false });

  useEffect(() => {
    let active = true;
    getStepUpSupport().then((detected) => {
      if (active) setSupport({ ...detected, checked: true });
    });
    return () => {
      active = false;
    };
  }, []);

  const startStepUp = useCallback((action, onVerified) => {
    setError('');
    setStatus('idle');
    setFallbackAcknowledged(false);
    setRequest({ action: getActionMeta(action), onVerified });
  }, []);

  const cancelStepUp = useCallback(() => {
    setRequest(null);
    setStatus('idle');
    setError('');
    setFallbackAcknowledged(false);
  }, []);

  const verifyPasskey = useCallback(async () => {
    if (!request) return;
    setStatus('verifying');
    setError('');
    let assertion;
    try {
      assertion = await performStepUp({ action: request.action.id, fetchChallenge });
    } catch (err) {
      const described = describeWebAuthnError(err);
      setStatus('error');
      setError(described.message);
      return;
    }
    const { onVerified } = request;
    setRequest(null);
    setStatus('idle');
    if (onVerified) {
      await onVerified({ passkeyAssertion: assertion, passkeyFallback: null });
    }
  }, [request, fetchChallenge]);

  const continueWithoutPasskey = useCallback(async () => {
    if (!request) return;
    const { onVerified } = request;
    setRequest(null);
    setStatus('idle');
    setError('');
    setFallbackAcknowledged(false);
    if (onVerified) {
      await onVerified({
        passkeyAssertion: null,
        passkeyFallback: STEP_UP_FALLBACK_UNSUPPORTED,
      });
    }
  }, [request]);

  const handleFallbackAcknowledgedChange = useCallback((checked) => {
    setFallbackAcknowledged(Boolean(checked));
  }, []);

  return {
    isStepUpOpen: Boolean(request),
    startStepUp,
    cancelStepUp,
    stepUpModalProps: {
      open: Boolean(request),
      action: request?.action,
      status,
      error,
      support,
      fallbackAcknowledged,
      onFallbackAcknowledgedChange: handleFallbackAcknowledgedChange,
      onVerify: verifyPasskey,
      onFallback: continueWithoutPasskey,
      onCancel: cancelStepUp,
    },
  };
}
