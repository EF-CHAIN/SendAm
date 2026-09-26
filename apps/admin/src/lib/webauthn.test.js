import { describe, it, expect, afterEach } from 'vitest';
import {
  HIGH_RISK_ACTIONS,
  STEP_UP_FALLBACK_UNSUPPORTED,
  WebAuthnStepUpError,
  base64UrlToBuffer,
  bufferToBase64Url,
  buildStepUpHeaders,
  buildStepUpPayload,
  describeWebAuthnError,
  getActionMeta,
  getStepUpSupport,
  isWebAuthnSupported,
  performStepUp,
  requestPasskeyAssertion,
  resolveStepUpChallenge,
  serializeAssertion,
} from './webauthn';
import { buildFakeCredential, installWebAuthnMock, uninstallWebAuthnMock } from '../test/passkeys';

const toArray = (buffer) => Array.from(new Uint8Array(buffer));

afterEach(() => {
  uninstallWebAuthnMock();
});

describe('webauthn capability detection', () => {
  it('reports no support when the browser exposes no WebAuthn API', async () => {
    expect(isWebAuthnSupported()).toBe(false);
    await expect(getStepUpSupport()).resolves.toEqual({
      supported: false,
      platformAuthenticator: false,
    });
  });

  it('reports support and platform authenticator availability when present', async () => {
    installWebAuthnMock({ platformAuthenticator: true });
    expect(isWebAuthnSupported()).toBe(true);
    await expect(getStepUpSupport()).resolves.toEqual({
      supported: true,
      platformAuthenticator: true,
    });
  });

  it('treats a missing platform authenticator as no built-in sensor', async () => {
    installWebAuthnMock({ platformAuthenticator: false });
    await expect(getStepUpSupport()).resolves.toEqual({
      supported: true,
      platformAuthenticator: false,
    });
  });
});

describe('webauthn base64url helpers', () => {
  it('round-trips arbitrary bytes without padding or URL-unsafe characters', () => {
    const original = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = bufferToBase64Url(original.buffer);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(toArray(base64UrlToBuffer(encoded))).toEqual(toArray(original.buffer));
  });

  it('returns null for empty buffers', () => {
    expect(bufferToBase64Url(null)).toBeNull();
    expect(base64UrlToBuffer(null)).toBeNull();
  });
});

describe('requestPasskeyAssertion', () => {
  it('refuses to call the browser when WebAuthn is unsupported', async () => {
    await expect(requestPasskeyAssertion({ challenge: 'abc' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('requires a challenge before prompting the device', async () => {
    installWebAuthnMock();
    await expect(requestPasskeyAssertion({ challenge: '' })).rejects.toMatchObject({
      code: 'missing_challenge',
    });
  });

  it('requests a user-verified assertion and serializes the credential', async () => {
    const { get } = installWebAuthnMock();
    const assertion = await requestPasskeyAssertion({
      challenge: bufferToBase64Url(new Uint8Array([9, 9])),
      allowCredentials: [{ id: bufferToBase64Url(new Uint8Array([1])), type: 'public-key' }],
      timeout: 1234,
    });

    expect(get).toHaveBeenCalledTimes(1);
    const { publicKey } = get.mock.calls[0][0];
    expect(publicKey.userVerification).toBe('required');
    expect(publicKey.timeout).toBe(1234);
    expect(publicKey.rpId).toBe('localhost');
    expect(toArray(publicKey.challenge)).toEqual([9, 9]);
    expect(toArray(publicKey.allowCredentials[0].id)).toEqual([1]);

    expect(assertion).toMatchObject({
      id: 'test-credential-id',
      type: 'public-key',
      authenticatorAttachment: 'platform',
    });
    expect(assertion.response.clientDataJSON).toBe(bufferToBase64Url(new Uint8Array([5, 6, 7])));
    expect(assertion.response.signature).toBe(bufferToBase64Url(new Uint8Array([10, 11, 12])));
    expect(assertion.response.userHandle).toBeNull();
    expect(() => JSON.stringify(assertion)).not.toThrow();
  });

  it('surfaces a retryable error when the operator cancels the prompt', async () => {
    installWebAuthnMock({
      getError: Object.assign(new Error('user denied'), { name: 'NotAllowedError' }),
    });
    await expect(requestPasskeyAssertion({ challenge: 'abc' })).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});

describe('challenge resolution and full step-up', () => {
  it('prefers a server-issued challenge', async () => {
    const result = await resolveStepUpChallenge('kyc.approve', {
      fetchChallenge: async () => ({
        challenge: 'server-challenge',
        rpId: 'admin.example.com',
        allowCredentials: [],
      }),
    });
    expect(result).toMatchObject({
      challenge: 'server-challenge',
      rpId: 'admin.example.com',
      source: 'server',
    });
  });

  it('falls back to a locally generated challenge when the API is unavailable', async () => {
    const result = await resolveStepUpChallenge('kyc.approve', {
      fetchChallenge: async () => {
        throw new Error('404');
      },
    });
    expect(result.source).toBe('client');
    expect(typeof result.challenge).toBe('string');
    expect(result.challenge.length).toBeGreaterThan(10);
  });

  it('runs the assertion end to end through performStepUp', async () => {
    const { get } = installWebAuthnMock();
    const assertion = await performStepUp({
      action: 'user.deactivate',
      fetchChallenge: async () => ({ challenge: bufferToBase64Url(new Uint8Array([7])) }),
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(assertion.response.signature).toBeTruthy();
    expect(assertion.response.clientDataJSON).toBeTruthy();
  });
});

describe('step-up payload builders', () => {
  it('attaches the assertion to JSON mutation payloads', () => {
    const assertion = serializeAssertion(buildFakeCredential());
    expect(buildStepUpPayload({ passkeyAssertion: assertion })).toEqual({
      passkeyAssertion: assertion,
      passkeyFallback: null,
    });
    expect(buildStepUpPayload()).toEqual({ passkeyAssertion: null, passkeyFallback: null });
  });

  it('attaches the assertion to download headers and flags the fallback', () => {
    const assertion = serializeAssertion(buildFakeCredential());
    const headers = buildStepUpHeaders({
      passkeyAssertion: assertion,
      passkeyFallback: STEP_UP_FALLBACK_UNSUPPORTED,
    });
    expect(JSON.parse(headers['X-WebAuthn-Assertion'])).toEqual(assertion);
    expect(headers['X-WebAuthn-Fallback']).toBe(STEP_UP_FALLBACK_UNSUPPORTED);
    expect(buildStepUpHeaders()).toEqual({});
  });
});

describe('action metadata and error messages', () => {
  it('resolves known action ids to operator-facing copy', () => {
    expect(getActionMeta('user.deactivate')).toBe(HIGH_RISK_ACTIONS['user.deactivate']);
    expect(getActionMeta('user.evidence.download').label).toMatch(/evidence/i);
    expect(getActionMeta()).toMatchObject({ id: 'high-risk-action' });
    expect(getActionMeta('unknown.action').label).toBe('unknown.action');
  });

  it('keeps a full descriptor when one is supplied', () => {
    expect(
      getActionMeta({ id: 'custom', label: 'Custom action', description: 'Custom description' })
    ).toMatchObject({ id: 'custom', label: 'Custom action', description: 'Custom description' });
  });

  it('maps WebAuthn DOMException names to actionable copies', () => {
    expect(describeWebAuthnError(new WebAuthnStepUpError('nope', 'cancelled'))).toEqual({
      code: 'cancelled',
      message: 'nope',
    });
    expect(describeWebAuthnError({ name: 'SecurityError' }).code).toBe('unsupported');
    expect(describeWebAuthnError({ name: 'InvalidStateError' }).code).toBe('no_credential');
    expect(describeWebAuthnError({ name: 'AbortError' }).code).toBe('aborted');
    expect(describeWebAuthnError(new Error('kaboom'))).toMatchObject({
      code: 'unknown',
      message: 'kaboom',
    });
    expect(describeWebAuthnError(undefined).code).toBe('unknown');
  });
});

describe('serializeAssertion', () => {
  it('tolerates credentials without extension results', () => {
    const credential = buildFakeCredential();
    delete credential.getClientExtensionResults;
    expect(serializeAssertion(credential).clientExtensionResults).toEqual({});
  });

  it('does not mutate the credential buffers', () => {
    const credential = buildFakeCredential();
    const before = toArray(credential.response.signature);
    serializeAssertion(credential);
    expect(toArray(credential.response.signature)).toEqual(before);
  });
});
