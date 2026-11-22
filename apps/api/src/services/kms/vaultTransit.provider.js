// VaultTransitProvider implementation using CommonJS
// Provides encryption, decryption, data‑key handling and token renewal via HashiCorp Vault Transit engine.

const axios = require('axios');
const { Buffer } = require('buffer');

/**
 * Factory function to create a VaultTransitProvider.
 * @param {Object} options
 * @param {string} options.endpoint - Base URL of the Vault server (e.g., http://localhost:8200).
 * @param {string} options.token - Initial Vault token.
 * @param {string} options.keyName - Name of the transit key.
 * @param {string} [options.mountPath='transit'] - Mount path of the transit engine.
 * @param {object} [options.httpClient] - Optional custom axios instance.
 * @param {number} [options.tokenRenewalIntervalMs] - Interval (ms) for automatic token renewal.
 * @returns {VaultTransitProvider}
 */
function createVaultTransitProvider(options) {
  return new VaultTransitProvider(options);
}

class VaultTransitProvider {
  /** @param {Object} opts */
  constructor(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new Error('Provider options must be an object');
    }
    const {
      endpoint,
      token,
      keyName,
      mountPath = 'transit',
      httpClient,
      tokenRenewalIntervalMs,
    } = opts;

    if (!endpoint) throw new Error('endpoint is required');
    if (!token) throw new Error('token is required');
    if (!keyName) throw new Error('keyName is required');

    this.endpoint = endpoint.replace(/\/*$/g, ''); // trim trailing slash
    this.token = token;
    this.keyName = keyName;
    this.mountPath = mountPath.replace(/^\/*|\/*$/g, ''); // trim leading/trailing slashes
    this.http = httpClient || axios.create({ baseURL: this.endpoint });

    // Attach interceptor to add the X-Vault-Token header to every request
    this.http.interceptors.request.use((config) => {
      config.headers = config.headers || {};
      config.headers['X-Vault-Token'] = this.token;
      return config;
    });

    this._autoRenewTimer = null;
    if (tokenRenewalIntervalMs) {
      this.startAutoTokenRenewal(tokenRenewalIntervalMs);
    }
  }

  /** Build API path for a given action */
  _path(action) {
    return `/v1/${this.mountPath}/${action}/${this.keyName}`;
  }

  /** Encrypt plaintext using the transit key.
   * @param {string|Buffer} plaintext
   * @param {Object} [opts]
   * @param {string|Buffer} [opts.context]
   * @param {number} [opts.keyVersion]
   * @returns {Promise<string>} Vault‑formatted ciphertext.
   */
  async encrypt(plaintext, opts = {}) {
    const payload = {
      plaintext: Buffer.isBuffer(plaintext)
        ? plaintext.toString('base64')
        : Buffer.from(plaintext).toString('base64'),
    };
    if (opts.context !== undefined) {
      payload.context = Buffer.isBuffer(opts.context)
        ? opts.context.toString('base64')
        : Buffer.from(opts.context).toString('base64');
    }
    if (opts.keyVersion !== undefined) {
      payload.key_version = opts.keyVersion;
    }

    const resp = await this.http.post(this._path('encrypt'), payload);
    return resp.data && resp.data.data && resp.data.data.ciphertext;
  }

  /** Decrypt ciphertext using the transit key.
   * @param {string} ciphertext - Vault‑formatted ciphertext.
   * @param {Object} [opts]
   * @param {string|Buffer} [opts.context]
   * @returns {Promise<string>} Decrypted plaintext.
   */
  async decrypt(ciphertext, opts = {}) {
    const payload = { ciphertext };
    if (opts.context !== undefined) {
      payload.context = Buffer.isBuffer(opts.context)
        ? opts.context.toString('base64')
        : Buffer.from(opts.context).toString('base64');
    }
    const resp = await this.http.post(this._path('decrypt'), payload);
    const b64 = resp.data && resp.data.data && resp.data.data.plaintext;
    return Buffer.from(b64, 'base64').toString();
  }

  /** Generate a data key (plaintext + encrypted) using the transit key.
   * @param {Object} [opts]
   * @param {string|Buffer} [opts.context]
   * @param {number} [opts.bits=256]
   * @returns {Promise<{plaintextKey: Buffer, encryptedDataKey: string}>}
   */
  async generateDataKey(opts = {}) {
    const { context, bits = 256 } = opts;
    const payload = { bits };
    if (context !== undefined) {
      payload.context = Buffer.isBuffer(context)
        ? context.toString('base64')
        : Buffer.from(context).toString('base64');
    }
    const resp = await this.http.post(this._path('datakey/plaintext'), payload);
    const data = resp.data && resp.data.data;
    return {
      plaintextKey: Buffer.from(data.plaintext, 'base64'),
      encryptedDataKey: data.ciphertext,
    };
  }

  /** Decrypt an encrypted data key.
   * @param {string|Object} ciphertextKeyOrOptions - Either ciphertext string or { ciphertext, context }.
   * @param {string|Buffer} [context]
   * @returns {Promise<Buffer>} Plaintext key.
   */
  async decryptDataKey(ciphertextKeyOrOptions, context) {
    let ciphertext;
    let opts = {};
    if (typeof ciphertextKeyOrOptions === 'object' && ciphertextKeyOrOptions !== null && ciphertextKeyOrOptions.ciphertext) {
      ciphertext = ciphertextKeyOrOptions.ciphertext;
      opts = ciphertextKeyOrOptions;
    } else {
      ciphertext = ciphertextKeyOrOptions;
      if (context !== undefined) opts.context = context;
    }
    if (!ciphertext) {
      throw new Error('ciphertext is required');
    }
    const payload = { ciphertext };
    if (opts.context !== undefined) {
      payload.context = Buffer.isBuffer(opts.context)
        ? opts.context.toString('base64')
        : Buffer.from(opts.context).toString('base64');
    }
    const resp = await this.http.post(this._path('decrypt'), payload);
    const b64 = resp.data && resp.data.data && resp.data.data.plaintext;
    return Buffer.from(b64, 'base64');
  }

  /** Renew the current token.
   * @param {Object} [opts]
   * @param {number} [opts.increment] - Seconds to extend the lease.
   * @returns {Promise<Object>} Auth information returned by Vault.
   */
  async renewToken(opts = {}) {
    const payload = {};
    if (opts.increment !== undefined) payload.increment = opts.increment;
    const resp = await this.http.post('/v1/auth/token/renew-self', payload);
    const auth = resp.data && resp.data.auth;
    if (auth && auth.client_token) {
      this.token = auth.client_token;
    }
    return auth;
  }

  /** Start automatic token renewal.
   * @param {number} intervalMs
   */
  startAutoTokenRenewal(intervalMs) {
    if (this._autoRenewTimer) clearInterval(this._autoRenewTimer);
    this._autoRenewTimer = setInterval(() => {
      this.renewToken().catch(() => {});
    }, intervalMs);
  }

  /** Stop automatic token renewal. */
  stopAutoTokenRenewal() {
    if (this._autoRenewTimer) {
      clearInterval(this._autoRenewTimer);
      this._autoRenewTimer = null;
    }
  }

  /** Simple health‑check call. */
  async healthCheck() {
    const resp = await this.http.get('/v1/sys/health');
    return resp.data;
  }
}

module.exports = { VaultTransitProvider, createVaultTransitProvider };
