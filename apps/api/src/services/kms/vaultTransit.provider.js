'use strict';

const axios = require('axios');
const logger = require('../../utils/logger');

const DEFAULT_MOUNT = 'transit';
const DEFAULT_KEY_NAME = 'sendam-wallet-key';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RENEW_THRESHOLD_SEC = 300;
const EXPECTED_DEK_BYTES = 32;

const VAULT_ERROR_CODES = Object.freeze({
  MISCONFIGURED: 'VAULT_MISCONFIGURED',
  AUTH_FAILED: 'VAULT_AUTH_FAILED',
  TOKEN_RENEWAL_FAILED: 'VAULT_TOKEN_RENEWAL_FAILED',
  INVALID_CIPHERTEXT: 'VAULT_INVALID_CIPHERTEXT',
  KEY_NOT_FOUND: 'VAULT_KEY_NOT_FOUND',
  UNAVAILABLE: 'VAULT_UNAVAILABLE',
  PROVIDER_ERROR: 'VAULT_PROVIDER_ERROR',
});

const redactVaultError = (message, token) => {
  let safe = String(message || 'Vault Transit request failed')
    .replace(/S[A-Z2-7]{55}/g, '[REDACTED_SECRET]');
  if (token && token.length >= 6) {
    safe = safe.split(token).join('[REDACTED_VAULT_TOKEN]');
  }
  return safe;
};

const classifyVaultError = (error, operation, token) => {
  const status = error?.response?.status;
  const vaultErrors = Array.isArray(error?.response?.data?.errors)
    ? error.response.data.errors.join('; ')
    : '';
  const rawMessage = vaultErrors || error?.message || 'Unknown Vault error';
  const safeMsg = redactVaultError(rawMessage, token);

  if (status === 403 || status === 401) {
    return Object.assign(
      new Error(`Vault Transit ${operation} unauthorized: ${safeMsg}`),
      { code: VAULT_ERROR_CODES.AUTH_FAILED, statusCode: status, retryable: false, cause: error },
    );
  }

  if (status === 404) {
    return Object.assign(
      new Error(`Vault Transit key or path not found during ${operation}: ${safeMsg}`),
      { code: VAULT_ERROR_CODES.KEY_NOT_FOUND, statusCode: 404, retryable: false, cause: error },
    );
  }

  if (status === 400) {
    return Object.assign(
      new Error(`Vault Transit ${operation} rejected request: ${safeMsg}`),
      { code: VAULT_ERROR_CODES.INVALID_CIPHERTEXT, statusCode: 400, retryable: false, cause: error },
    );
  }

  if (status === 503 || error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') {
    return Object.assign(
      new Error(`Vault Transit unavailable during ${operation}: ${safeMsg}`),
      { code: VAULT_ERROR_CODES.UNAVAILABLE, statusCode: status || 503, retryable: true, cause: error },
    );
  }

  return Object.assign(
    new Error(`Vault Transit ${operation} failed: ${safeMsg}`),
    { code: VAULT_ERROR_CODES.PROVIDER_ERROR, statusCode: status || 502, retryable: status >= 500, cause: error },
  );
};

const encodeBase64 = (value) => {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return Buffer.from(String(value), 'utf8').toString('base64');
};

const encodeContext = (context) => {
  if (!context) return undefined;
  if (typeof context === 'string') return encodeBase64(context);
  if (Buffer.isBuffer(context)) return context.toString('base64');
  if (typeof context === 'object') {
    const sorted = Object.keys(context)
      .sort()
      .reduce((acc, key) => {
        if (context[key] !== undefined && context[key] !== null) {
          acc[key] = String(context[key]);
        }
        return acc;
      }, {});
    return encodeBase64(JSON.stringify(sorted));
  }
  return undefined;
};

/**
 * Creates a HashiCorp Vault Transit Secret Engine provider.
 *
 * Supports both:
 * 1. Zero-exposure direct Transit encryption/decryption/rewrap (`encrypt`, `decrypt`, `rewrap`)
 *    where raw master keys never leave Vault.
 * 2. Envelope KMS provider compatibility (`generateDataKey`, `decryptDataKey`) so it can plug
 *    directly into `crypto.service.js` via `setKmsProvider(...)`.
 * 3. Automatic Vault token lease tracking and renewal (`/v1/auth/token/renew-self`).
 */
const createVaultTransitProvider = ({
  address = process.env.VAULT_ADDR,
  token = process.env.VAULT_TOKEN,
  namespace = process.env.VAULT_NAMESPACE || null,
  mount = process.env.VAULT_TRANSIT_MOUNT || DEFAULT_MOUNT,
  keyName = process.env.VAULT_TRANSIT_KEY || DEFAULT_KEY_NAME,
  timeoutMs = Number(process.env.VAULT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  tokenRenewThresholdSec = Number(process.env.VAULT_TOKEN_RENEW_THRESHOLD_SEC || DEFAULT_RENEW_THRESHOLD_SEC),
  tokenRenewIncrement = process.env.VAULT_TOKEN_RENEW_INCREMENT || undefined,
  autoRenewToken = true,
  httpClient = null,
} = {}) => {
  const normalizedAddr = String(address || '').replace(/\/+$/, '');
  if (!normalizedAddr) {
    throw Object.assign(new Error('VAULT_ADDR is required for Vault Transit provider.'), {
      code: VAULT_ERROR_CODES.MISCONFIGURED,
    });
  }
  if (!token || typeof token !== 'string') {
    throw Object.assign(new Error('VAULT_TOKEN is required for Vault Transit provider.'), {
      code: VAULT_ERROR_CODES.MISCONFIGURED,
    });
  }

  let currentToken = token;
  let tokenExpiresAtMs = null;
  let tokenRenewable = true;
  let renewalInFlight = null;
  let renewalTimer = null;

  const client = httpClient || axios.create({
    baseURL: normalizedAddr,
    timeout: timeoutMs,
  });

  const buildHeaders = () => ({
    'X-Vault-Token': currentToken,
    'Content-Type': 'application/json',
    ...(namespace ? { 'X-Vault-Namespace': namespace } : {}),
  });

  const transitPath = (action, targetKey) => {
    const cleanMount = String(mount || DEFAULT_MOUNT).replace(/^\/+|\/+$/g, '');
    const resolvedKey = encodeURIComponent(targetKey || keyName);
    return `/v1/${cleanMount}/${action}/${resolvedKey}`;
  };

  /**
   * Inspects the current token lease via `/v1/auth/token/lookup-self`.
   */
  const lookupToken = async () => {
    try {
      const response = await client.get('/v1/auth/token/lookup-self', {
        headers: buildHeaders(),
      });
      const data = response?.data?.data || {};
      const ttl = Number(data.ttl || 0);
      tokenRenewable = Boolean(data.renewable);
      tokenExpiresAtMs = ttl > 0 ? Date.now() + ttl * 1000 : null;
      return {
        renewable: tokenRenewable,
        ttl,
        policies: data.policies || [],
        accessor: data.accessor || null,
      };
    } catch (error) {
      throw classifyVaultError(error, 'lookupToken', currentToken);
    }
  };

  /**
   * Renews the active Vault token lease via `/v1/auth/token/renew-self`.
   * Coalesces concurrent renewal calls so only one request is in flight at a time.
   */
  const renewToken = async ({ increment = tokenRenewIncrement } = {}) => {
    if (renewalInFlight) {
      return renewalInFlight;
    }

    renewalInFlight = (async () => {
      try {
        const body = increment ? { increment } : {};
        const response = await client.post('/v1/auth/token/renew-self', body, {
          headers: buildHeaders(),
        });
        const auth = response?.data?.auth || {};
        if (auth.client_token) {
          currentToken = auth.client_token;
        }
        const leaseDuration = Number(auth.lease_duration || 0);
        tokenRenewable = auth.renewable !== false;
        tokenExpiresAtMs = leaseDuration > 0 ? Date.now() + leaseDuration * 1000 : null;
        logger.info('vault_token_renewed', {
          leaseDuration,
          renewable: tokenRenewable,
        });
        return {
          leaseDuration,
          renewable: tokenRenewable,
          policies: auth.policies || [],
        };
      } catch (error) {
        const classified = classifyVaultError(error, 'renewToken', currentToken);
        classified.code = VAULT_ERROR_CODES.TOKEN_RENEWAL_FAILED;
        logger.error('vault_token_renewal_failed', { error: classified.message });
        throw classified;
      } finally {
        renewalInFlight = null;
      }
    })();

    return renewalInFlight;
  };

  const ensureValidToken = async () => {
    if (!autoRenewToken || !tokenRenewable || !tokenExpiresAtMs) {
      return;
    }
    const remainingSec = (tokenExpiresAtMs - Date.now()) / 1000;
    if (remainingSec <= tokenRenewThresholdSec) {
      await renewToken();
    }
  };

  const requestWithRenewal = async (operation, fn) => {
    await ensureValidToken();
    try {
      return await fn();
    } catch (error) {
      const status = error?.response?.status;
      if (status === 403 && autoRenewToken && tokenRenewable) {
        try {
          await renewToken();
          return await fn();
        } catch (_retryError) {
          throw classifyVaultError(error, operation, currentToken);
        }
      }
      throw classifyVaultError(error, operation, currentToken);
    }
  };

  /**
   * Delegates direct encryption to Vault Transit (`POST /v1/<mount>/encrypt/<key>`).
   */
  const encrypt = async ({
    plaintext,
    keyName: targetKey = keyName,
    context = null,
    keyVersion = undefined,
  } = {}) => {
    if (plaintext === undefined || plaintext === null || plaintext === '') {
      throw Object.assign(new Error('plaintext is required for Vault Transit encryption.'), {
        code: VAULT_ERROR_CODES.INVALID_CIPHERTEXT,
      });
    }

    const payload = {
      plaintext: encodeBase64(plaintext),
      ...(context ? { context: encodeContext(context) } : {}),
      ...(Number.isInteger(keyVersion) ? { key_version: keyVersion } : {}),
    };

    const response = await requestWithRenewal('encrypt', () =>
      client.post(transitPath('encrypt', targetKey), payload, {
        headers: buildHeaders(),
      }),
    );

    const data = response?.data?.data;
    if (!data?.ciphertext) {
      throw Object.assign(new Error('Vault Transit encrypt returned no ciphertext.'), {
        code: VAULT_ERROR_CODES.PROVIDER_ERROR,
      });
    }

    return {
      ciphertext: data.ciphertext,
      keyVersion: data.key_version != null ? `v${data.key_version}` : 'v1',
      keyName: targetKey,
    };
  };

  /**
   * Delegates direct decryption to Vault Transit (`POST /v1/<mount>/decrypt/<key>`).
   */
  const decrypt = async ({
    ciphertext,
    keyName: targetKey = keyName,
    context = null,
    asBuffer = false,
  } = {}) => {
    if (typeof ciphertext !== 'string' || !ciphertext.startsWith('vault:v')) {
      throw Object.assign(new Error('Malformed Vault Transit ciphertext: expected vault:v<n>:... format.'), {
        code: VAULT_ERROR_CODES.INVALID_CIPHERTEXT,
      });
    }

    const payload = {
      ciphertext,
      ...(context ? { context: encodeContext(context) } : {}),
    };

    const response = await requestWithRenewal('decrypt', () =>
      client.post(transitPath('decrypt', targetKey), payload, {
        headers: buildHeaders(),
      }),
    );

    const data = response?.data?.data;
    if (typeof data?.plaintext !== 'string') {
      throw Object.assign(new Error('Vault Transit decrypt returned no plaintext.'), {
        code: VAULT_ERROR_CODES.PROVIDER_ERROR,
      });
    }

    const decoded = Buffer.from(data.plaintext, 'base64');
    if (asBuffer) return decoded;
    const text = decoded.toString('utf8');
    decoded.fill(0);
    return text;
  };

  /**
   * Rewraps ciphertext to the latest Vault Transit key version without exposing plaintext.
   */
  const rewrap = async ({
    ciphertext,
    keyName: targetKey = keyName,
    context = null,
    keyVersion = undefined,
  } = {}) => {
    if (typeof ciphertext !== 'string' || !ciphertext.startsWith('vault:v')) {
      throw Object.assign(new Error('Malformed Vault Transit ciphertext for rewrap.'), {
        code: VAULT_ERROR_CODES.INVALID_CIPHERTEXT,
      });
    }

    const payload = {
      ciphertext,
      ...(context ? { context: encodeContext(context) } : {}),
      ...(Number.isInteger(keyVersion) ? { key_version: keyVersion } : {}),
    };

    const response = await requestWithRenewal('rewrap', () =>
      client.post(transitPath('rewrap', targetKey), payload, {
        headers: buildHeaders(),
      }),
    );

    const data = response?.data?.data;
    if (!data?.ciphertext) {
      throw Object.assign(new Error('Vault Transit rewrap returned no ciphertext.'), {
        code: VAULT_ERROR_CODES.PROVIDER_ERROR,
      });
    }

    return {
      ciphertext: data.ciphertext,
      keyVersion: data.key_version != null ? `v${data.key_version}` : 'v1',
      keyName: targetKey,
    };
  };

  /**
   * KMS Provider Interface: generates a 256-bit DEK via Vault Transit datakey endpoint.
   */
  const generateDataKey = async ({
    keyVersion = 'v1',
    keyName: targetKey = keyName,
    encryptionContext = null,
    bits = 256,
  } = {}) => {
    const payload = {
      bits,
      ...(encryptionContext ? { context: encodeContext(encryptionContext) } : {}),
    };

    const response = await requestWithRenewal('generateDataKey', () =>
      client.post(transitPath('datakey/plaintext', targetKey), payload, {
        headers: buildHeaders(),
      }),
    );

    const data = response?.data?.data;
    if (!data?.plaintext || !data?.ciphertext) {
      throw Object.assign(new Error('Vault Transit datakey returned incomplete key material.'), {
        code: VAULT_ERROR_CODES.PROVIDER_ERROR,
      });
    }

    const plaintextKey = Buffer.from(data.plaintext, 'base64');
    if (plaintextKey.length !== EXPECTED_DEK_BYTES) {
      plaintextKey.fill(0);
      throw Object.assign(
        new Error(`Unexpected DEK length from Vault Transit: expected ${EXPECTED_DEK_BYTES} bytes, got ${plaintextKey.length}.`),
        { code: VAULT_ERROR_CODES.PROVIDER_ERROR },
      );
    }

    return {
      plaintextKey,
      encryptedDataKey: data.ciphertext,
      keyId: targetKey,
      keyVersion: data.key_version != null ? `v${data.key_version}` : keyVersion,
    };
  };

  /**
   * KMS Provider Interface: decrypts a Vault-wrapped DEK ciphertext.
   */
  const decryptDataKey = async ({
    encryptedDataKey,
    keyName: targetKey = keyName,
    encryptionContext = null,
  } = {}) => {
    const plaintextKey = await decrypt({
      ciphertext: encryptedDataKey,
      keyName: targetKey,
      context: encryptionContext,
      asBuffer: true,
    });

    if (plaintextKey.length !== EXPECTED_DEK_BYTES) {
      plaintextKey.fill(0);
      throw Object.assign(
        new Error(`Unexpected decrypted DEK length from Vault Transit: expected ${EXPECTED_DEK_BYTES} bytes, got ${plaintextKey.length}.`),
        { code: VAULT_ERROR_CODES.PROVIDER_ERROR },
      );
    }

    return plaintextKey;
  };

  /**
   * Starts a background token renewal interval that unrefs itself so it never blocks shutdown.
   */
  const startTokenRenewalLoop = (intervalMs = 60_000) => {
    stopTokenRenewalLoop();
    renewalTimer = setInterval(async () => {
      try {
        await ensureValidToken();
      } catch (error) {
        logger.warn('vault_background_token_renewal_error', { error: error.message });
      }
    }, intervalMs);
    if (typeof renewalTimer.unref === 'function') {
      renewalTimer.unref();
    }
    return renewalTimer;
  };

  const stopTokenRenewalLoop = () => {
    if (renewalTimer) {
      clearInterval(renewalTimer);
      renewalTimer = null;
    }
  };

  const healthCheck = async () => {
    try {
      const response = await client.get('/v1/sys/health', {
        headers: buildHeaders(),
        validateStatus: (status) => status < 500 || status === 429 || status === 472 || status === 473,
      });
      return {
        ok: response.status === 200 || response.status === 429 || response.status === 472 || response.status === 473,
        initialized: Boolean(response?.data?.initialized),
        sealed: Boolean(response?.data?.sealed),
        status: response.status,
      };
    } catch (error) {
      throw classifyVaultError(error, 'healthCheck', currentToken);
    }
  };

  const getTokenMetadata = () => ({
    expiresAtMs: tokenExpiresAtMs,
    renewable: tokenRenewable,
  });

  const setTokenExpiresAtMs = (ts) => {
    tokenExpiresAtMs = ts;
  };

  return {
    name: 'vault-transit',
    encrypt,
    decrypt,
    rewrap,
    generateDataKey,
    decryptDataKey,
    lookupToken,
    renewToken,
    ensureValidToken,
    startTokenRenewalLoop,
    stopTokenRenewalLoop,
    healthCheck,
    getTokenMetadata,
    setTokenExpiresAtMs,
  };
};

module.exports = {
  VAULT_ERROR_CODES,
  createVaultTransitProvider,
  classifyVaultError,
};
