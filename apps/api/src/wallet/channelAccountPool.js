const { server: defaultServer, StellarSdk } = require('../config/stellar');
const config = require('../config/env');
const logger = require('../utils/logger');
const { assertValidAmount } = require('../utils/money');

const DEFAULT_POOL_SIZE = 50;
const DEFAULT_MIN_BALANCE_XLM = 2.0;
const DEFAULT_TARGET_BALANCE_XLM = 5.0;
const DEFAULT_INITIAL_FUNDING_XLM = 5.0;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BAD_SEQ_RETRIES = 2;
const STROOPS_PER_XLM = 1e7;

class ChannelPoolTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChannelPoolTimeoutError';
    this.code = 'CHANNEL_POOL_TIMEOUT';
    this.isChannelPoolTimeout = true;
  }
}

class ChannelPoolExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChannelPoolExhaustedError';
    this.code = 'CHANNEL_POOL_EXHAUSTED';
  }
}

const getDefaultNetworkPassphrase = () => (
  config.stellar?.networkPassphrase
  || (config.stellar?.network === 'mainnet' || config.stellar?.network === 'public'
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET)
);

const isBadSequenceError = (error) => {
  const txCode = error?.response?.data?.extras?.result_codes?.transaction;
  if (txCode === 'tx_bad_seq') return true;
  return typeof error?.message === 'string' && /tx_bad_seq/i.test(error.message);
};

const isAccountNotFoundError = (error) => (
  error?.response?.status === 404
  || error?.name === 'NotFoundError'
  || (typeof error?.message === 'string' && /not found|404/i.test(error.message))
);

const extractNativeBalanceXlm = (accountResponse) => {
  const balances = accountResponse?.balances;
  if (!Array.isArray(balances)) return null;
  const native = balances.find((b) => b.asset_type === 'native');
  const parsed = Number(native?.balance);
  return Number.isFinite(parsed) ? parsed : 0;
};

const resolveAsset = (asset = 'XLM') => {
  if (asset instanceof StellarSdk.Asset) return asset;
  const code = String(asset || 'XLM').trim().toUpperCase();
  if (code === 'XLM' || code === 'NATIVE') {
    return StellarSdk.Asset.native();
  }
  if (code === 'USDC') {
    const issuer = config.stellar?.usdcIssuer;
    if (!issuer) {
      throw new Error('USDC issuer is not configured.');
    }
    return new StellarSdk.Asset('USDC', issuer);
  }
  throw new Error(`Unsupported asset: ${asset}`);
};

class ChannelAccountPool {
  constructor({
    baseKeypair = null,
    baseSecretKey = null,
    channelSecrets = null,
    poolSize = DEFAULT_POOL_SIZE,
    server = defaultServer,
    networkPassphrase = getDefaultNetworkPassphrase(),
    minBalanceXlm = DEFAULT_MIN_BALANCE_XLM,
    targetBalanceXlm = DEFAULT_TARGET_BALANCE_XLM,
    initialFundingXlm = DEFAULT_INITIAL_FUNDING_XLM,
    acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
    maxBadSeqRetries = DEFAULT_MAX_BAD_SEQ_RETRIES,
    autoProvision = true,
  } = {}) {
    if (!baseKeypair && !baseSecretKey) {
      throw new Error('Either baseKeypair or baseSecretKey is required to initialize ChannelAccountPool.');
    }

    this.baseKeypair = baseKeypair || StellarSdk.Keypair.fromSecret(baseSecretKey);
    this.basePublicKey = this.baseKeypair.publicKey();
    this.server = server;
    this.networkPassphrase = networkPassphrase;
    this.minBalanceXlm = Number(minBalanceXlm);
    this.targetBalanceXlm = Math.max(Number(targetBalanceXlm), this.minBalanceXlm + 0.5);
    this.initialFundingXlm = Number(initialFundingXlm);
    this.acquireTimeoutMs = Number(acquireTimeoutMs);
    this.maxBadSeqRetries = Number(maxBadSeqRetries);
    this.autoProvision = Boolean(autoProvision);

    const keypairs = Array.isArray(channelSecrets) && channelSecrets.length > 0
      ? channelSecrets.map((secret) => (
        typeof secret === 'string' ? StellarSdk.Keypair.fromSecret(secret) : secret
      ))
      : Array.from({ length: Math.max(1, Number(poolSize) || DEFAULT_POOL_SIZE) }, () => StellarSdk.Keypair.random());

    this._channels = keypairs.map((keypair, index) => ({
      id: `channel-${index}`,
      index,
      keypair,
      publicKey: keypair.publicKey(),
      inUse: false,
      account: null,
      balanceXlm: null,
      sequenceDirty: true,
      replenishingPromise: null,
      submissions: 0,
      replenishments: 0,
      lastUsedAt: null,
    }));

    this._waitQueue = [];
    this._baseLockTail = Promise.resolve();
    this._metrics = {
      totalSubmissions: 0,
      totalReplenishments: 0,
      totalProvisions: 0,
      sequenceResyncs: 0,
    };
  }

  /**
   * Serializes transactions sourced from the base funding account (channel provisioning
   * and reserve replenishments) so they never collide on the base account sequence number.
   */
  async _withBaseAccountLock(fn) {
    const prev = this._baseLockTail;
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    this._baseLockTail = prev.then(() => next, () => next);

    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Acquires an exclusive lease on an idle channel account.
   * Queues callers in FIFO order when all channels are busy.
   */
  async acquire({ timeoutMs = this.acquireTimeoutMs } = {}) {
    const idle = this._channels.find((ch) => !ch.inUse);
    if (idle) {
      idle.inUse = true;
      idle.lastUsedAt = Date.now();
      return this._createLease(idle);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        settled: false,
        resolve: (channel) => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          channel.lastUsedAt = Date.now();
          resolve(this._createLease(channel));
        },
        reject: (err) => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(err);
        },
        timer: null,
      };

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this._waitQueue.indexOf(waiter);
          if (idx !== -1) this._waitQueue.splice(idx, 1);
          waiter.reject(
            new ChannelPoolTimeoutError(
              `Timed out after ${timeoutMs}ms waiting for an available Stellar channel account (pool size: ${this._channels.length}).`,
            ),
          );
        }, timeoutMs);
      }

      this._waitQueue.push(waiter);
    });
  }

  _createLease(channel) {
    let released = false;
    return {
      channel,
      markSequenceDirty: () => {
        channel.sequenceDirty = true;
      },
      release: () => {
        if (released) return;
        released = true;
        this._releaseChannel(channel);
      },
    };
  }

  _releaseChannel(channel) {
    while (this._waitQueue.length > 0) {
      const nextWaiter = this._waitQueue.shift();
      if (!nextWaiter.settled) {
        // Keep channel.inUse = true and hand off directly to next waiter.
        nextWaiter.resolve(channel);
        return;
      }
    }
    channel.inUse = false;
  }

  /**
   * Provisions a channel account on-chain from the base funding account if it does not exist.
   */
  async provisionChannel(channel) {
    return this._withBaseAccountLock(async () => {
      const baseAccount = await this.server.loadAccount(this.basePublicKey);
      const fee = await this.server.fetchBaseFee();
      const tx = new StellarSdk.TransactionBuilder(baseAccount, {
        fee: String(fee),
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.createAccount({
            destination: channel.publicKey,
            startingBalance: this.initialFundingXlm.toFixed(7),
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.baseKeypair);
      const response = await this.server.submitTransaction(tx);
      this._metrics.totalProvisions += 1;
      channel.balanceXlm = this.initialFundingXlm;
      channel.sequenceDirty = true;

      logger.info('Provisioned Stellar channel account', {
        channelId: channel.id,
        channelPublicKey: channel.publicKey,
        startingBalance: this.initialFundingXlm,
        txHash: response?.hash,
      });

      return response;
    });
  }

  /**
   * Replenishes a channel account's XLM reserve from the base funding account
   * when its native balance falls below `minBalanceXlm`.
   */
  async replenishChannel(channel, { currentBalanceXlm = channel.balanceXlm } = {}) {
    if (channel.replenishingPromise) {
      return channel.replenishingPromise;
    }

    const current = Number.isFinite(currentBalanceXlm) ? currentBalanceXlm : 0;
    const topUp = Math.max(this.targetBalanceXlm - current, 1.0);

    channel.replenishingPromise = this._withBaseAccountLock(async () => {
      const baseAccount = await this.server.loadAccount(this.basePublicKey);
      const fee = await this.server.fetchBaseFee();
      const tx = new StellarSdk.TransactionBuilder(baseAccount, {
        fee: String(fee),
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: channel.publicKey,
            asset: StellarSdk.Asset.native(),
            amount: topUp.toFixed(7),
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.baseKeypair);
      const response = await this.server.submitTransaction(tx);

      channel.balanceXlm = current + topUp;
      channel.replenishments += 1;
      this._metrics.totalReplenishments += 1;

      logger.info('Replenished Stellar channel account reserve', {
        channelId: channel.id,
        channelPublicKey: channel.publicKey,
        topUpXlm: topUp.toFixed(7),
        newBalanceXlm: channel.balanceXlm.toFixed(7),
        txHash: response?.hash,
      });

      return {
        replenished: true,
        topUpXlm: topUp,
        newBalanceXlm: channel.balanceXlm,
        txHash: response?.hash,
      };
    }).finally(() => {
      channel.replenishingPromise = null;
    });

    return channel.replenishingPromise;
  }

  /**
   * Ensures a channel's sequence number is loaded and its XLM reserve is above `minBalanceXlm`.
   */
  async _prepareChannel(channel) {
    if (!channel.account || channel.sequenceDirty) {
      let loaded;
      try {
        loaded = await this.server.loadAccount(channel.publicKey);
      } catch (error) {
        if (this.autoProvision && isAccountNotFoundError(error)) {
          await this.provisionChannel(channel);
          loaded = await this.server.loadAccount(channel.publicKey);
        } else {
          throw error;
        }
      }

      const seq = typeof loaded.sequenceNumber === 'function'
        ? loaded.sequenceNumber()
        : String(loaded.sequence);
      channel.account = new StellarSdk.Account(channel.publicKey, seq);
      const nativeBal = extractNativeBalanceXlm(loaded);
      if (nativeBal !== null) {
        channel.balanceXlm = nativeBal;
      }
      channel.sequenceDirty = false;
    }

    if (channel.balanceXlm !== null && channel.balanceXlm < this.minBalanceXlm) {
      await this.replenishChannel(channel, { currentBalanceXlm: channel.balanceXlm });
    }

    return channel.account;
  }

  /**
   * Executes a custom transaction builder/submission callback with an exclusively leased
   * channel account. Automatically handles sequence preparation and lease release.
   */
  async executeWithChannel(fn, options = {}) {
    if (typeof fn !== 'function') {
      throw new Error('executeWithChannel requires a callback function.');
    }

    const lease = await this.acquire(options);
    try {
      const channelAccount = await this._prepareChannel(lease.channel);
      return await fn({
        channel: lease.channel,
        channelKeypair: lease.channel.keypair,
        channelPublicKey: lease.channel.publicKey,
        channelAccount,
        baseKeypair: this.baseKeypair,
        basePublicKey: this.basePublicKey,
        markSequenceDirty: lease.markSequenceDirty,
      });
    } finally {
      lease.release();
    }
  }

  /**
   * Submits a payment using a dedicated channel account for the outer transaction
   * envelope (independent sequence number & fee) while keeping the base account
   * as the sole source of payment funds.
   */
  async submitPayment({
    destination,
    amount,
    asset = 'XLM',
    memo = null,
    timeoutSeconds = 30,
    feeStroops = null,
    acquireTimeoutMs = this.acquireTimeoutMs,
  }) {
    if (!destination || typeof destination !== 'string') {
      throw new Error('A valid destination address is required.');
    }
    const normalizedAmount = assertValidAmount(amount, typeof asset === 'string' ? asset : 'XLM');
    const stellarAsset = resolveAsset(asset);

    const lease = await this.acquire({ timeoutMs: acquireTimeoutMs });
    const { channel } = lease;

    try {
      let lastError;
      for (let attempt = 0; attempt <= this.maxBadSeqRetries; attempt += 1) {
        const channelAccount = await this._prepareChannel(channel);
        const fee = feeStroops !== null && feeStroops !== undefined
          ? String(feeStroops)
          : String(await this.server.fetchBaseFee());

        // Snapshot current sequence before TransactionBuilder increments channelAccount in place.
        const currentSeq = channelAccount.sequenceNumber();
        const txAccount = new StellarSdk.Account(channel.publicKey, currentSeq);

        const builder = new StellarSdk.TransactionBuilder(txAccount, {
          fee,
          networkPassphrase: this.networkPassphrase,
        }).addOperation(
          StellarSdk.Operation.payment({
            source: this.basePublicKey,
            destination,
            asset: stellarAsset,
            amount: normalizedAmount,
          }),
        );

        if (memo) {
          builder.addMemo(memo);
        }

        const transaction = builder.setTimeout(timeoutSeconds).build();
        // Both channel (transaction source) and base account (payment operation source) sign.
        transaction.sign(channel.keypair, this.baseKeypair);

        try {
          const response = await this.server.submitTransaction(transaction);

          // Advance cached sequence to match the submitted transaction.
          channel.account = new StellarSdk.Account(channel.publicKey, txAccount.sequenceNumber());
          channel.submissions += 1;
          this._metrics.totalSubmissions += 1;

          // Update local XLM balance estimate and auto-replenish if low.
          if (channel.balanceXlm !== null) {
            channel.balanceXlm = Math.max(0, channel.balanceXlm - Number(fee) / STROOPS_PER_XLM);
            if (channel.balanceXlm < this.minBalanceXlm) {
              await this.replenishChannel(channel, { currentBalanceXlm: channel.balanceXlm });
            }
          }

          return {
            txHash: response?.hash || transaction.hash().toString('hex'),
            channelId: channel.id,
            channelPublicKey: channel.publicKey,
            basePublicKey: this.basePublicKey,
            sequenceNumber: transaction.sequence,
            feeStroops: fee,
            response,
          };
        } catch (error) {
          lastError = error;
          if (isBadSequenceError(error) && attempt < this.maxBadSeqRetries) {
            channel.sequenceDirty = true;
            this._metrics.sequenceResyncs += 1;
            logger.warn('Channel account encountered tx_bad_seq; resyncing sequence and retrying', {
              channelId: channel.id,
              channelPublicKey: channel.publicKey,
              attempt: attempt + 1,
            });
            continue;
          }
          // For any uncertain or terminal failure, mark sequence dirty so the next caller reloads.
          channel.sequenceDirty = true;
          throw error;
        }
      }

      throw lastError;
    } finally {
      lease.release();
    }
  }

  /**
   * Scans all idle channels on Horizon and replenishes any whose native XLM reserve
   * has fallen below `minBalanceXlm`.
   */
  async checkAndReplenishAll() {
    const results = [];
    for (const channel of this._channels) {
      if (channel.inUse) continue;
      try {
        const loaded = await this.server.loadAccount(channel.publicKey);
        const bal = extractNativeBalanceXlm(loaded);
        if (bal !== null) {
          channel.balanceXlm = bal;
          if (bal < this.minBalanceXlm) {
            const res = await this.replenishChannel(channel, { currentBalanceXlm: bal });
            results.push({ channelId: channel.id, publicKey: channel.publicKey, ...res });
          }
        }
      } catch (error) {
        if (this.autoProvision && isAccountNotFoundError(error)) {
          await this.provisionChannel(channel);
          results.push({ channelId: channel.id, publicKey: channel.publicKey, provisioned: true });
        } else {
          logger.warn('Failed to inspect channel balance during health sweep', {
            channelId: channel.id,
            error: error.message,
          });
        }
      }
    }
    return results;
  }

  getStats() {
    const inUseChannels = this._channels.filter((ch) => ch.inUse).length;
    return {
      basePublicKey: this.basePublicKey,
      totalChannels: this._channels.length,
      inUseChannels,
      availableChannels: this._channels.length - inUseChannels,
      queuedRequests: this._waitQueue.length,
      minBalanceXlm: this.minBalanceXlm,
      targetBalanceXlm: this.targetBalanceXlm,
      ...this._metrics,
      channels: this._channels.map((ch) => ({
        id: ch.id,
        publicKey: ch.publicKey,
        inUse: ch.inUse,
        balanceXlm: ch.balanceXlm,
        submissions: ch.submissions,
        replenishments: ch.replenishments,
      })),
    };
  }
}

const createChannelAccountPool = (options = {}) => new ChannelAccountPool(options);

module.exports = {
  ChannelAccountPool,
  ChannelPoolTimeoutError,
  ChannelPoolExhaustedError,
  createChannelAccountPool,
  DEFAULT_POOL_SIZE,
  DEFAULT_MIN_BALANCE_XLM,
  DEFAULT_TARGET_BALANCE_XLM,
};
