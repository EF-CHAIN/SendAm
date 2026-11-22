const axios = require('axios');
const {
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  xdr,
} = require('@stellar/stellar-sdk');

class Sep30RecoveryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'Sep30RecoveryError';
    this.details = details;
  }
}

const assertValidAddress = (address) => {
  if (typeof address !== 'string' || !StrKey.isValidEd25519PublicKey(address)) {
    throw new Sep30RecoveryError(`Invalid Stellar public key: ${address}`);
  }
};

const assertValidIdentities = (identities) => {
  if (!Array.isArray(identities) || identities.length === 0) {
    throw new Sep30RecoveryError('SEP-30 registration requires at least one recovery identity.');
  }
  for (const identity of identities) {
    if (!identity || typeof identity !== 'object') {
      throw new Sep30RecoveryError('Each recovery identity must be an object.');
    }
    if (!Array.isArray(identity.auth_methods) || identity.auth_methods.length === 0) {
      throw new Sep30RecoveryError('Each recovery identity must include at least one auth_method.');
    }
    for (const method of identity.auth_methods) {
      if (!method || typeof method.type !== 'string' || !method.type.trim() || typeof method.value !== 'string' || !method.value.trim()) {
        throw new Sep30RecoveryError('Each auth_method requires non-empty string type and value.');
      }
    }
  }
};

/**
 * SEP-30 Recovery Signer HTTP client for registering recovery identities
 * and requesting recovery signatures for a Stellar account.
 */
class Sep30Client {
  /**
   * @param {object} options
   * @param {string} options.serverUrl - Base URL of the SEP-30 recovery server
   * @param {object} [options.httpClient] - Axios-compatible HTTP client
   * @param {number} [options.timeoutMs=10000]
   */
  constructor({ serverUrl, httpClient = axios, timeoutMs = 10000 } = {}) {
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      throw new Sep30RecoveryError('Sep30Client requires a non-empty serverUrl.');
    }
    this.serverUrl = serverUrl.trim().replace(/\/+$/, '');
    this.httpClient = httpClient;
    this.timeoutMs = timeoutMs;
  }

  _headers(authToken) {
    if (typeof authToken !== 'string' || !authToken.trim()) {
      throw new Sep30RecoveryError('SEP-30 request requires a non-empty bearer authToken.');
    }
    return {
      Authorization: `Bearer ${authToken.trim()}`,
      'Content-Type': 'application/json',
    };
  }

  async registerAccount(address, identities, authToken) {
    assertValidAddress(address);
    assertValidIdentities(identities);
    const res = await this.httpClient.post(
      `${this.serverUrl}/accounts/${encodeURIComponent(address)}`,
      { identities },
      { headers: this._headers(authToken), timeout: this.timeoutMs },
    );
    return res.data;
  }

  async updateAccount(address, identities, authToken) {
    assertValidAddress(address);
    assertValidIdentities(identities);
    const res = await this.httpClient.put(
      `${this.serverUrl}/accounts/${encodeURIComponent(address)}`,
      { identities },
      { headers: this._headers(authToken), timeout: this.timeoutMs },
    );
    return res.data;
  }

  async getAccount(address, authToken) {
    assertValidAddress(address);
    const res = await this.httpClient.get(
      `${this.serverUrl}/accounts/${encodeURIComponent(address)}`,
      { headers: this._headers(authToken), timeout: this.timeoutMs },
    );
    return res.data;
  }

  async deleteAccount(address, authToken) {
    assertValidAddress(address);
    const res = await this.httpClient.delete(
      `${this.serverUrl}/accounts/${encodeURIComponent(address)}`,
      { headers: this._headers(authToken), timeout: this.timeoutMs },
    );
    return res.data;
  }

  async signTransaction(address, signingAddress, transactionXdr, authToken) {
    assertValidAddress(address);
    assertValidAddress(signingAddress);
    if (typeof transactionXdr !== 'string' || !transactionXdr.trim()) {
      throw new Sep30RecoveryError('transactionXdr must be a non-empty base64 XDR string.');
    }
    const res = await this.httpClient.post(
      `${this.serverUrl}/accounts/${encodeURIComponent(address)}/sign/${encodeURIComponent(signingAddress)}`,
      { transaction: transactionXdr },
      { headers: this._headers(authToken), timeout: this.timeoutMs },
    );
    if (!res.data || typeof res.data.signature !== 'string') {
      throw new Sep30RecoveryError('SEP-30 server did not return a valid signature.');
    }
    return res.data;
  }
}

/**
 * Coordinates multi-party threshold recovery across multiple SEP-30 recovery servers.
 */
class Sep30RecoveryCoordinator {
  /**
   * @param {object} options
   * @param {Array<{ id?: string, client: Sep30Client, signingAddress?: string }>} options.servers
   * @param {number} [options.threshold=2]
   * @param {string} [options.networkPassphrase]
   */
  constructor({
    servers = [],
    threshold = 2,
    networkPassphrase = Networks.TESTNET,
  } = {}) {
    if (!Array.isArray(servers) || servers.length === 0) {
      throw new Sep30RecoveryError('Sep30RecoveryCoordinator requires at least one recovery server.');
    }
    this.servers = servers.map((s, idx) => ({
      id: s.id || `recovery-server-${idx + 1}`,
      client: s.client,
      signingAddress: s.signingAddress || null,
    }));
    this.threshold = Math.max(1, Number(threshold) || 1);
    this.networkPassphrase = networkPassphrase;
  }

  /**
   * Registers recovery identities across all configured SEP-30 recovery servers.
   *
   * @param {object} params
   * @param {string} params.address
   * @param {Array} params.identities
   * @param {Record<string, string>} params.authTokens - Map of server id -> bearer token
   * @returns {Promise<{ address: string, signers: Array<{ serverId: string, key: string }>, threshold: number }>}
   */
  async registerRecovery({ address, identities, authTokens = {} }) {
    assertValidAddress(address);
    assertValidIdentities(identities);

    const signers = [];
    for (const server of this.servers) {
      const token = authTokens[server.id];
      const result = await server.client.registerAccount(address, identities, token);
      const primarySigner = Array.isArray(result.signers) && result.signers[0] ? result.signers[0].key : null;
      if (primarySigner) {
        server.signingAddress = primarySigner;
        signers.push({ serverId: server.id, key: primarySigner });
      }
    }

    if (signers.length < this.threshold) {
      throw new Sep30RecoveryError(
        `Registered only ${signers.length} recovery signer(s), fewer than required threshold ${this.threshold}.`,
        { signers, threshold: this.threshold },
      );
    }

    return {
      address,
      signers,
      threshold: this.threshold,
    };
  }

  /**
   * Collects threshold signatures from recovery servers and attaches them to the recovery transaction.
   *
   * @param {object} params
   * @param {string} params.address
   * @param {string} params.transactionXdr
   * @param {Record<string, string>} params.authTokens - Map of server id -> verified recovery bearer token
   * @param {number} [params.requiredThreshold]
   * @returns {Promise<{ transactionXdr: string, signaturesCollected: number, threshold: number, signersUsed: string[] }>}
   */
  async recoverAccount({
    address,
    transactionXdr,
    authTokens = {},
    requiredThreshold = this.threshold,
  }) {
    assertValidAddress(address);
    const tx = TransactionBuilder.fromXDR(transactionXdr, this.networkPassphrase);
    const signersUsed = [];
    const errors = [];

    for (const server of this.servers) {
      if (signersUsed.length >= requiredThreshold) break;

      const token = authTokens[server.id];
      if (!token) {
        errors.push({ serverId: server.id, error: 'Missing recovery auth token' });
        continue;
      }

      if (!server.signingAddress) {
        errors.push({ serverId: server.id, error: 'Missing signingAddress for recovery server' });
        continue;
      }

      try {
        const { signature } = await server.client.signTransaction(
          address,
          server.signingAddress,
          transactionXdr,
          token,
        );
        const hint = Keypair.fromPublicKey(server.signingAddress).signatureHint();
        const decoratedSig = new xdr.DecoratedSignature({
          hint,
          signature: Buffer.from(signature, 'base64'),
        });
        tx.signatures.push(decoratedSig);
        signersUsed.push(server.signingAddress);
      } catch (err) {
        errors.push({ serverId: server.id, error: err && err.message ? err.message : String(err) });
      }
    }

    if (signersUsed.length < requiredThreshold) {
      throw new Sep30RecoveryError(
        `Insufficient recovery signatures: collected ${signersUsed.length}, required ${requiredThreshold}.`,
        { signaturesCollected: signersUsed.length, threshold: requiredThreshold, errors },
      );
    }

    return {
      transactionXdr: tx.toXDR(),
      signaturesCollected: signersUsed.length,
      threshold: requiredThreshold,
      signersUsed,
    };
  }
}

module.exports = {
  Sep30Client,
  Sep30RecoveryCoordinator,
  Sep30RecoveryError,
};
