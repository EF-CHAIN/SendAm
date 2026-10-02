// Client-side WebAuthn / Passkey step-up authentication for high-risk admin
// actions (manual account deactivation, KYC overrides, compliance evidence
// downloads).
//
// Flow: the page intercepts a sensitive action, this module asks the API for a
// one-time challenge, calls `navigator.credentials.get()` so the operator's
// platform authenticator (Touch ID / Face ID / Windows Hello) or a roaming
// security key (YubiKey) signs it, and returns a JSON-serializable assertion
// that is attached to the mutation request for server-side verification.
//
// The module is deliberately framework-free: every browser interaction lives
// here so it can be unit tested in isolation, while the React orchestration is
// the `usePasskeyStepUp` hook exported from
// `apps/admin/src/components/PasskeyPromptModal.jsx`.

// The operator gets a minute to approve the device prompt before we give up and
// surface a retryable error.
export const STEP_UP_TIMEOUT_MS = 60_000;

// Attached to a mutation when the operator's device cannot do WebAuthn at all.
// The API records this so the audit trail shows the operation was performed
// without a biometric signature rather than silently treating it as verified.
export const STEP_UP_FALLBACK_UNSUPPORTED = 'unsupported_device';

const GENERIC_ACTION = {
  id: 'high-risk-action',
  label: 'High-risk action',
  description:
    'This operation is sensitive. Confirm it with your device passkey before it is submitted.',
};

// Copy for each intercepted operation, keyed by the ids the pages pass to
// `startStepUp()`. Kept here so the modal wording stays consistent everywhere.
export const HIGH_RISK_ACTIONS = {
  'user.deactivate': {
    id: 'user.deactivate',
    label: 'Deactivate customer account',
    description:
      'Deactivating an account disables the customer’s wallet and payment operations. Confirm with your device passkey (Touch ID, Face ID, Windows Hello, or a security key) before the change is submitted.',
  },
  'user.reactivate': {
    id: 'user.reactivate',
    label: 'Reactivate customer account',
    description:
      'Reactivating an account restores the customer’s wallet and payment operations. Confirm with your device passkey before the change is submitted.',
  },
  'user.evidence.download': {
    id: 'user.evidence.download',
    label: 'Download compliance evidence package',
    description:
      'Compliance evidence packages contain sensitive customer data. Confirm with your device passkey before the download starts.',
  },
  'kyc.approve': {
    id: 'kyc.approve',
    label: 'Approve KYC record',
    description:
      'Approving a KYC record clears a customer for higher transaction limits. Confirm with your device passkey before the decision is recorded.',
  },
  'kyc.reject': {
    id: 'kyc.reject',
    label: 'Reject KYC record',
    description:
      'Rejecting a KYC record blocks the customer’s onboarding. Confirm with your device passkey before the decision is recorded.',
  },
  'kyc.export': {
    id: 'kyc.export',
    label: 'Export KYC data',
    description:
      'KYC exports contain regulated personal data. Confirm with your device passkey before the export is generated.',
  },
};

export class WebAuthnStepUpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WebAuthnStepUpError';
    this.code = code;
  }
}

// Metadata is normally an id from HIGH_RISK_ACTIONS, but callers may pass a
// full descriptor object (or nothing) and still get complete modal copy.
export function getActionMeta(action) {
  if (!action) return GENERIC_ACTION;
  if (typeof action === 'string') {
    return HIGH_RISK_ACTIONS[action] || { ...GENERIC_ACTION, id: action, label: action };
  }
  return { ...GENERIC_ACTION, ...action };
}

export function isWebAuthnSupported() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (typeof window.PublicKeyCredential === 'undefined') return false;
  return Boolean(navigator.credentials && typeof navigator.credentials.get === 'function');
}

// A false result does not mean WebAuthn is unusable — the operator may still
// have a roaming security key. It only tells the modal whether to mention that
// no built-in sensor was detected.
export async function isPlatformAuthenticatorAvailable() {
  if (!isWebAuthnSupported()) return false;
  const publicKeyCredential = window.PublicKeyCredential;
  if (typeof publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
    return false;
  }
  try {
    return Boolean(await publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export async function getStepUpSupport() {
  const supported = isWebAuthnSupported();
  if (!supported) return { supported: false, platformAuthenticator: false };
  return { supported: true, platformAuthenticator: await isPlatformAuthenticatorAvailable() };
}

export function bufferToBase64Url(buffer) {
  if (buffer == null) return null;
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBuffer(value) {
  if (value == null) return null;
  if (value instanceof ArrayBuffer) return value;
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  const padded = remainder === 0 ? normalized : normalized + '='.repeat(4 - remainder);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return new TextEncoder().encode(String(value)).buffer;
  }
}

// A locally generated challenge keeps step-up functional when the challenge
// endpoint is not reachable. The server still verifies the signature against
// clientDataJSON; freshness/replay protection is the server's job once it
// issues challenges itself.
export function createClientChallenge(size = 32) {
  const bytes = new Uint8Array(size);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < size; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function serializeAssertion(credential) {
  const response = credential.response || {};
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type || 'public-key',
    authenticatorAttachment: credential.authenticatorAttachment || null,
    clientExtensionResults:
      typeof credential.getClientExtensionResults === 'function'
        ? credential.getClientExtensionResults()
        : {},
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
    },
  };
}

export function describeWebAuthnError(error) {
  if (error instanceof WebAuthnStepUpError) {
    return { code: error.code, message: error.message };
  }
  const name = error && error.name;
  if (name === 'NotAllowedError') {
    return {
      code: 'cancelled',
      message:
        'Passkey verification was cancelled or timed out. Approve the prompt on your device to continue.',
    };
  }
  if (name === 'NotSupportedError' || name === 'SecurityError') {
    return {
      code: 'unsupported',
      message:
        'This device or origin cannot use passkeys. Use a device with a biometric sensor or a security key, or continue with the fallback.',
    };
  }
  if (name === 'InvalidStateError') {
    return {
      code: 'no_credential',
      message: 'No passkey is registered for this admin account on this device.',
    };
  }
  if (name === 'AbortError') {
    return { code: 'aborted', message: 'Passkey verification was aborted. Please try again.' };
  }
  return {
    code: 'unknown',
    message: (error && error.message) || 'Passkey verification failed. Please try again.',
  };
}

function toPasskeyError(error) {
  const described = describeWebAuthnError(error);
  const wrapped = new WebAuthnStepUpError(described.message, described.code);
  wrapped.cause = error;
  return wrapped;
}

// Server-issued challenge when available, otherwise a locally generated one so
// a missing step-up endpoint never permanently blocks a high-risk operation.
export async function resolveStepUpChallenge(action, { fetchChallenge } = {}) {
  if (typeof fetchChallenge === 'function') {
    try {
      const issued = await fetchChallenge({ action });
      const challenge = issued && (issued.challenge || (issued.data && issued.data.challenge));
      if (challenge) {
        return {
          challenge,
          rpId: issued.rpId || (issued.data && issued.data.rpId),
          allowCredentials:
            issued.allowCredentials || (issued.data && issued.data.allowCredentials) || [],
          source: 'server',
        };
      }
    } catch {
      // Fall through to the local challenge below.
    }
  }
  return {
    challenge: bufferToBase64Url(createClientChallenge()),
    rpId: undefined,
    allowCredentials: [],
    source: 'client',
  };
}

// `navigator.credentials.get()` with a `publicKey` assertion request — the
// browser routes this to the platform authenticator or a security key.
export async function requestPasskeyAssertion({
  challenge,
  rpId,
  allowCredentials = [],
  timeout = STEP_UP_TIMEOUT_MS,
  userVerification = 'required',
} = {}) {
  if (!isWebAuthnSupported()) {
    throw new WebAuthnStepUpError(
      'This browser does not support WebAuthn passkeys.',
      'unsupported'
    );
  }
  if (!challenge) {
    throw new WebAuthnStepUpError(
      'A WebAuthn challenge is required to start step-up verification.',
      'missing_challenge'
    );
  }

  const publicKey = {
    challenge: typeof challenge === 'string' ? base64UrlToBuffer(challenge) : challenge,
    allowCredentials: (allowCredentials || []).map((credential) => ({
      ...credential,
      id: typeof credential.id === 'string' ? base64UrlToBuffer(credential.id) : credential.id,
    })),
    userVerification,
    timeout,
  };
  const resolvedRpId = rpId || (typeof window !== 'undefined' ? window.location.hostname : '');
  if (resolvedRpId) publicKey.rpId = resolvedRpId;

  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey });
  } catch (error) {
    throw toPasskeyError(error);
  }
  if (!credential) {
    throw new WebAuthnStepUpError(
      'No passkey credential was returned by the authenticator.',
      'no_credential'
    );
  }
  return serializeAssertion(credential);
}

// One-call step-up: challenge + assertion, ready to attach to a mutation.
export async function performStepUp({
  action,
  fetchChallenge,
  timeout = STEP_UP_TIMEOUT_MS,
  userVerification = 'required',
} = {}) {
  const { challenge, rpId, allowCredentials } = await resolveStepUpChallenge(action, {
    fetchChallenge,
  });
  return requestPasskeyAssertion({
    challenge,
    rpId,
    allowCredentials,
    timeout,
    userVerification,
  });
}

// Body fields for JSON mutations (deactivate/reactivate/KYC review). Always
// present so the server can distinguish "no assertion supplied" from
// "assertion stripped by an older client".
export function buildStepUpPayload(stepUp = {}) {
  return {
    passkeyAssertion: stepUp.passkeyAssertion ?? null,
    passkeyFallback: stepUp.passkeyFallback ?? null,
  };
}

// Header form for blob downloads, where the payload cannot ride in a JSON body.
export function buildStepUpHeaders(stepUp = {}) {
  const headers = {};
  if (stepUp.passkeyAssertion) {
    headers['X-WebAuthn-Assertion'] = JSON.stringify(stepUp.passkeyAssertion);
  }
  if (stepUp.passkeyFallback) {
    headers['X-WebAuthn-Fallback'] = stepUp.passkeyFallback;
  }
  return headers;
}
