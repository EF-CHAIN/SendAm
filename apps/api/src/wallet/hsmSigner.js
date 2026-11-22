'use strict';

const axios = require('axios');
const { StellarSdk } = require('../config/stellar');

class HsmSignerClient {
  constructor(options = {}) {
    if (!options.endpoint) {
      throw new Error('HSM endpoint is required');
    }
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.apiKey = options.apiKey || null;
    this.timeoutMs = options.timeoutMs || 5000;
    this.httpClient = options.httpClient || axios.create({
      baseURL: this.endpoint,
      timeout: this.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
    });
  }

  async healthCheck() {
    const res = await this.httpClient.get('/v1/health');
    return res.data;
  }

  async getPublicKey(keyId) {
    if (!keyId) throw new Error('keyId is required');
    const res = await this.httpClient.get(`/v1/keys/${encodeURIComponent(keyId)}`);
    const pubKey = res.data?.publicKey;
    if (!pubKey || !StellarSdk.StrKey.isValidEd25519PublicKey(pubKey)) {
      throw new Error(`Invalid public key returned from HSM for keyId ${keyId}`);
    }
    return pubKey;
  }

  async signHash({ keyId, hash, publicKey = null }) {
    if (!keyId) throw new Error('keyId is required');
    if (!hash) throw new Error('hash is required');

    const hashBuffer = Buffer.isBuffer(hash) ? hash : Buffer.from(hash, 'hex');
    if (hashBuffer.length !== 32) {
      throw new Error(`Invalid hash length: expected 32 bytes, got ${hashBuffer.length}`);
    }

    const payload = {
      keyId,
      hash: hashBuffer.toString('hex'),
    };

    const res = await this.httpClient.post('/v1/sign', payload);
    const data = res.data;

    const signatureRaw = data?.signature;
    if (!signatureRaw) {
      throw new Error('HSM response missing signature');
    }

    const signatureBuffer = Buffer.from(signatureRaw, data.signatureFormat || 'hex');
    const resolvedPublicKey = publicKey || data.publicKey;
    if (!resolvedPublicKey) {
      throw new Error('Public key required to verify HSM signature');
    }

    // Verify Ed25519 signature before returning to guarantee cryptographic integrity
    const verifier = StellarSdk.Keypair.fromPublicKey(resolvedPublicKey);
    const isValid = verifier.verify(hashBuffer, signatureBuffer);
    if (!isValid) {
      throw new Error('Cryptographic signature verification failed for HSM response');
    }

    return {
      signature: signatureBuffer,
      publicKey: resolvedPublicKey,
    };
  }

  async signTransaction(transaction, { keyId, publicKey = null, networkPassphrase = null } = {}) {
    if (!transaction) throw new Error('Transaction is required');
    if (!keyId) throw new Error('keyId is required');

    let resolvedPublicKey = publicKey;
    if (!resolvedPublicKey) {
      resolvedPublicKey = await this.getPublicKey(keyId);
    }

    const txHash = transaction.hash(networkPassphrase);
    const { signature } = await this.signHash({
      keyId,
      hash: txHash,
      publicKey: resolvedPublicKey,
    });

    const sigBase64 = Buffer.isBuffer(signature) ? signature.toString('base64') : signature;
    transaction.addSignature(resolvedPublicKey, sigBase64);
    return transaction;
  }
}

function createHsmSigner(options) {
  return new HsmSignerClient(options);
}

module.exports = {
  HsmSignerClient,
  createHsmSigner,
};
