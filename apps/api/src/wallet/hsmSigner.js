'use strict';

const https = require('https');
const axios = require('axios');
const { StellarSdk } = require('../config/stellar');
const { outboundHeaders } = require('../observability/context');
const logger = require('../utils/logger');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 150;
const ED25519_HASH_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

const HSM_ERROR_CODES = Object.freeze({
  MISCONFIGURED: 'HSM_MISCONFIGURED',
  INVALID_INPUT: 'HSM_INVALID_INPUT',
  AUTH_FAILED: 'HSM_AUTH_FAILED',
  POLICY_DENIED: 'HSM_POLICY_DENIED',
  KEY_NOT_FOUND: 'HSM_KEY_NOT_FOUND',
  INVALID_SIGNATURE: 'HSM_INVALID_SIGNATURE',
  UNAVAILABLE: 'HSM_UNAVAILABLE',
  SIGNING_FAILED: 'HSM_SIGNING_FAILED',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const classifyHsmError = (error, operation) => {
  const status = error?.response?.status;
  const serverMsg = error?.response?.data?.error || error?.response?.data?.message || error?.message || 'HSM request failed';
  const safeMsg = String(serverMsg).replace(/S[A-Z2-7]{55}/g, '[REDACTED_SECRET]');

  if (status === 401) {
    return Object.assign(new Error(`HSM ${operation} authentication failed: ${safeMsg}`), {
      code: HSM_ERROR_CODES.AUTH_FAILED,
      statusCode: 401,
      retryable: false,
      cause: error,
    });
  }

  if (status === 403) {
    return Object.assign(new Error(`HSM ${operation} denied by signing policy: ${safeMsg}`), {
      code: HSM_ERROR_CODES.POLICY_DENIED,
      statusCode: 403,
      retryable: false,
      cause: error,
    });
  }

  if (status === 404) {
    return Object.assign(new Error(`HSM key not found during ${operation}: ${safeMsg}`), {
      code: HSM_ERROR_CODES.KEY_NOT_FOUND,
      statusCode: 404,
      retryable: false,
      cause: error,
    });
  }

  if (status === 400) {
    return Object.assign(new Error(`HSM ${operation} rejected invalid request: ${safeMsg}`), {
      code: HSM_ERROR_CODES.INVALID_INPUT,
      statusCode: 400,
      retryable: false,
      cause: error,
    });
  }

  const retryable = status >= 500
    || status === 429
    || error?.code === 'ECONNREFUSED'
    || error?.code === 'ECONNRESET'
    || error?.code === 'ETIMEDOUT'
    || error?.code === 'ECONNABORTED';

  return Object.assign(new Error(`HSM ${operation} failed: ${safeMsg}`), {
    code: retryable ? HSM_ERROR_CODES.UNAVAILABLE : HSM_ERROR_CODES.SIGNING_FAILED,
    statusCode: status || 503,
    retryable,
    cause: error,
  });
};

const normalizeHashBuffer = (hash) => {
  if (Buffer.isBuffer(hash)) {
    if (hash.length !== ED25519_HASH_BYTES) {
      throw Object.assign(
        new Error(`Transaction hash must be ${ED25519_HASH_BYTES} bytes (got ${hash.length}).`),
        { code: HSM_ERROR_CODES.INVALID_INPUT, retryable: false },
      );
    }
    return hash;
  }

  if (hash instanceof Uint8Array) {
    const buf = Buffer.from(hash);
    if (buf.length !== ED25519_HASH_BYTES) {
      throw Object.assign(
        new Error(`Transaction hash must be ${ED25519_HASH_BYTES} bytes (got ${buf.length}).`),
        { code: HSM_ERROR_CODES.INVALID_INPUT, retryable: false },
      );
    }
    return buf;
  }

  if (typeof hash === 'string') {
    const trimmed = hash.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === ED25519_HASH_BYTES) {
      return decoded;
    }
  }

  throw Object.assign(
    new Error('Transaction hash must be a 32-byte Buffer, 64-char hex string, or base64-encoded 32-byte value.'),
    { code: HSM_ERROR_CODES.INVALID_INPUT, retryable: false },
  );
};

const parseSignatureBuffer = (rawSignature) => {
  if (Buffer.isBuffer(rawSignature)) {
    if (rawSignature.length === ED25519_SIGNATURE_BYTES) return rawSignature;
  } else if (rawSignature instanceof Uint8Array) {
    const buf = Buffer.from(rawSignature);
    if (buf.length === ED25519_SIGNATURE_BYTES) return buf;
  } else if (typeof rawSignature === 'string') {
    const trimmed = rawSignature.trim();
    if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === ED25519_SIGNATURE_BYTES) {
      return decoded;
    }
  }

  throw Object.assign(
    new Error(`HSM returned an invalid Ed25519 signature (expected ${ED25519_SIGNATURE_BYTES} bytes).`),
    { code: HSM_ERROR_CODES.INVALID_SIGNATURE, retryable: false },
  );
};

/**
 * Remote Hardware Security Module (HSM) / isolated signing service client.
 *
 * Sends 32-byte Stellar transaction hashes over authenticated HTTP/mTLS to an
 * isolated signing boundary and receives 64-byte Ed25519 signatures back.
 * Raw private keys never reside in the API process heap.
 */
const createHsmSigner = ({
  endpoint = process.env.HSM_ENDPOINT,
  apiKey = process.env.HSM_API_KEY,
  timeoutMs = Number(process.env.HSM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  maxRetries = Number(process.env.HSM_MAX_RETRIES || DEFAULT_MAX_RETRIES),
  retryBaseDelayMs = Number(process.env.HSM_RETRY_BASE_DELAY_MS || DEFAULT_RETRY_BASE_DELAY_MS),
  verifySignatures = true,
  clientCert = process.env.HSM_CLIENT_CERT || null,
  clientKey = process.env.HSM_CLIENT_KEY || null,
  caCert = process.env.HSM_CA_CERT || null,
  httpClient = null,
} = {}) => {
  const normalizedEndpoint = String(endpoint || '').replace(/\/+$/, '');
  if (!normalizedEndpoint) {
    throw Object.assign(new Error('HSM_ENDPOINT is required to initialize HSM signer.'), {
      code: HSM_ERROR_CODES.MISCONFIGURED,
    });
  }

  let httpsAgent;
  if (!httpClient && (clientCert || clientKey || caCert)) {
    httpsAgent = new https.Agent({
      ...(clientCert ? { cert: clientCert } : {}),
      ...(clientKey ? { key: clientKey } : {}),
      ...(caCert ? { ca: caCert } : {}),
      rejectUnauthorized: true,
    });
  }

  const client = httpClient || axios.create({
    baseURL: normalizedEndpoint,
    timeout: timeoutMs,
    ...(httpsAgent ? { httpsAgent } : {}),
  });

  const buildHeaders = (extra = {}) => ({
    'Content-Type': 'application/json',
    ...outboundHeaders(),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  });

  const executeWithRetry = async (operation, fn) => {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        const classified = classifyHsmError(error, operation);
        lastError = classified;
        if (!classified.retryable || attempt >= maxRetries) {
          logger.error('hsm_operation_failed', {
            operation,
            code: classified.code,
            attempt: attempt + 1,
          });
          throw classified;
        }
        logger.warn('hsm_operation_retrying', {
          operation,
          code: classified.code,
          attempt: attempt + 1,
          maxRetries,
        });
        await sleep(retryBaseDelayMs * (2 ** attempt));
      }
    }
    throw lastError;
  };

  /**
   * Requests an Ed25519 signature over a 32-byte transaction hash from the remote HSM.
   */
  const signHash = async ({ keyId, publicKey, hash, context = null } = {}) => {
    if (!keyId && !publicKey) {
      throw Object.assign(new Error('Either keyId or publicKey is required for HSM signing.'), {
        code: HSM_ERROR_CODES.INVALID_INPUT,
        retryable: false,
      });
    }

    if (publicKey && !StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      throw Object.assign(new Error('Invalid Stellar Ed25519 publicKey provided to HSM signer.'), {
        code: HSM_ERROR_CODES.INVALID_INPUT,
        retryable: false,
      });
    }

    const hashBuf = normalizeHashBuffer(hash);
    const payload = {
      ...(keyId ? { keyId } : {}),
      ...(publicKey ? { publicKey } : {}),
      hash: hashBuf.toString('base64'),
      algorithm: 'Ed25519',
      ...(context ? { context } : {}),
    };

    const response = await executeWithRetry('signHash', () =>
      client.post('/v1/sign', payload, { headers: buildHeaders() }),
    );

    const data = response?.data || {};
    const signature = parseSignatureBuffer(data.signature);
    const resolvedPublicKey = publicKey || data.publicKey;

    if (verifySignatures && resolvedPublicKey) {
      const verifier = StellarSdk.Keypair.fromPublicKey(resolvedPublicKey);
      const valid = verifier.verify(hashBuf, signature);
      if (!valid) {
        throw Object.assign(
          new Error('HSM returned a signature that failed local Ed25519 verification.'),
          { code: HSM_ERROR_CODES.INVALID_SIGNATURE, retryable: false },
        );
      }
    }

    const hint = resolvedPublicKey
      ? StellarSdk.Keypair.fromPublicKey(resolvedPublicKey).signatureHint()
      : null;

    return {
      signature,
      signatureBase64: signature.toString('base64'),
      hint,
      keyId: keyId || data.keyId || null,
      publicKey: resolvedPublicKey || null,
    };
  };

  /**
   * Signs a Stellar Transaction or FeeBumpTransaction using the remote HSM.
   * Only the 32-byte transaction hash is transmitted; private keys never touch API memory.
   */
  const signTransaction = async ({ transaction, keyId, publicKey, context = null } = {}) => {
    if (!transaction || typeof transaction.hash !== 'function') {
      throw Object.assign(new Error('A valid Stellar transaction object is required for HSM signing.'), {
        code: HSM_ERROR_CODES.INVALID_INPUT,
        retryable: false,
      });
    }

    const targetPublicKey = publicKey || transaction.source;
    if (!targetPublicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(targetPublicKey)) {
      throw Object.assign(new Error('A valid Stellar Ed25519 publicKey is required to attach HSM signature.'), {
        code: HSM_ERROR_CODES.INVALID_INPUT,
        retryable: false,
      });
    }

    const txHash = transaction.hash();
    const { signature, signatureBase64 } = await signHash({
      keyId: keyId || targetPublicKey,
      publicKey: targetPublicKey,
      hash: txHash,
      context,
    });

    if (typeof transaction.addSignature === 'function') {
      transaction.addSignature(targetPublicKey, signatureBase64);
    } else if (Array.isArray(transaction.signatures)) {
      const hint = StellarSdk.Keypair.fromPublicKey(targetPublicKey).signatureHint();
      transaction.signatures.push(new StellarSdk.xdr.DecoratedSignature({ hint, signature }));
    } else {
      throw Object.assign(new Error('Transaction object does not support attaching signatures.'), {
        code: HSM_ERROR_CODES.INVALID_INPUT,
        retryable: false,
      });
    }

    return transaction;
  };

  /**
   * Creates a lightweight per-wallet signer adapter compatible with `stellar.adapter.js`.
   */
  const forAccount = ({ keyId, publicKey, context = null }) => {
    if (!publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      throw Object.assign(new Error('A valid Stellar Ed25519 publicKey is required for HSM account signer.'), {
        code: HSM_ERROR_CODES.INVALID_INPUT,
      });
    }
    return {
      mode: 'hsm',
      keyId: keyId || publicKey,
      publicKey,
      signTransaction: (transaction) => signTransaction({
        transaction,
        keyId: keyId || publicKey,
        publicKey,
        context,
      }),
    };
  };

  /**
   * Retrieves the Ed25519 Stellar public key for an HSM-managed key.
   */
  const getPublicKey = async ({ keyId }) => {
    if (!keyId) {
      throw Object.assign(new Error('keyId is required to fetch HSM public key.'), {
        code: HSM_ERROR_CODES.INVALID_INPUT,
      });
    }

    const response = await executeWithRetry('getPublicKey', () =>
      client.get(`/v1/keys/${encodeURIComponent(keyId)}/public-key`, {
        headers: buildHeaders(),
      }),
    );

    const publicKey = response?.data?.publicKey;
    if (!publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      throw Object.assign(new Error('HSM returned an invalid Stellar public key.'), {
        code: HSM_ERROR_CODES.SIGNING_FAILED,
      });
    }

    return { keyId, publicKey };
  };

  /**
   * Provisions a new non-exportable Ed25519 keypair inside the HSM.
   */
  const createKey = async ({ keyId = undefined, metadata = {} } = {}) => {
    const response = await executeWithRetry('createKey', () =>
      client.post('/v1/keys', {
        algorithm: 'Ed25519',
        exportable: false,
        ...(keyId ? { keyId } : {}),
        metadata,
      }, { headers: buildHeaders() }),
    );

    const data = response?.data || {};
    if (!data.publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(data.publicKey)) {
      throw Object.assign(new Error('HSM createKey did not return a valid Stellar publicKey.'), {
        code: HSM_ERROR_CODES.SIGNING_FAILED,
      });
    }

    return {
      keyId: data.keyId || keyId || data.publicKey,
      publicKey: data.publicKey,
    };
  };

  const healthCheck = async () => {
    const response = await executeWithRetry('healthCheck', () =>
      client.get('/v1/health', { headers: buildHeaders() }),
    );
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data: response.data || {},
    };
  };

  return {
    name: 'hsm-signer',
    signHash,
    signTransaction,
    forAccount,
    getPublicKey,
    createKey,
    healthCheck,
  };
};

module.exports = {
  HSM_ERROR_CODES,
  createHsmSigner,
  classifyHsmError,
  normalizeHashBuffer,
};
