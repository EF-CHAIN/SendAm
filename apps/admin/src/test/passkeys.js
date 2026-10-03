import { vi } from 'vitest';

// Shared WebAuthn test doubles. jsdom ships neither `PublicKeyCredential` nor
// `navigator.credentials`, so tests that exercise the passkey step-up install
// these stubs and remove them again in `afterEach`.
//
// `installWebAuthnMock()` models a device with a platform authenticator whose
// prompt is approved. Pass `getError` to model a cancelled / denied prompt and
// `platformAuthenticator: false` to model a device with no built-in sensor.

const bytes = (...values) => new Uint8Array(values).buffer;

export function buildFakeCredential(overrides = {}) {
  return {
    id: 'test-credential-id',
    rawId: bytes(1, 2, 3, 4),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: bytes(5, 6, 7),
      authenticatorData: bytes(8, 9),
      signature: bytes(10, 11, 12),
      userHandle: null,
    },
    ...overrides,
  };
}

export function installWebAuthnMock({
  credential = buildFakeCredential(),
  getError = null,
  platformAuthenticator = true,
} = {}) {
  vi.stubGlobal(
    'PublicKeyCredential',
    class {
      static isUserVerifyingPlatformAuthenticatorAvailable() {
        return Promise.resolve(platformAuthenticator);
      }
    }
  );

  const get = getError ? vi.fn().mockRejectedValue(getError) : vi.fn().mockResolvedValue(credential);
  Object.defineProperty(window.navigator, 'credentials', {
    configurable: true,
    value: { get },
  });

  return { get };
}

export function uninstallWebAuthnMock() {
  vi.unstubAllGlobals();
  if (Object.prototype.hasOwnProperty.call(window.navigator, 'credentials')) {
    delete window.navigator.credentials;
  }
}
