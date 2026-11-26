'use strict';

const StellarSdk = require('@stellar/stellar-sdk');
const config = require('../config/env');
const logger = require('../utils/logger');
const { add, subtract, compare, assertValidAmount } = require('../utils/money');

const DEFAULT_POOL_SIZE = 3;
const DEFAULT_MAX_BALANCE_XLM = 500.0; // Hard cap on hot wallet balance
const DEFAULT_MIN_BALANCE_XLM = 50.0;  // Threshold to trigger replenishment & alert
const DEFAULT_TARGET_REPLENISH_XLM = 200.0; // Target level when topped up (< max balance)
const DEFAULT_MULTISIG_REQUIRED_WEIGHT = 2; // 2-of-3 cold storage signers

class HotWalletPoolError extends Error {
  constructor(message, code = 'HOT_WALLET_POOL_ERROR') {
    super(message);
    this.name = 'HotWalletPoolError';
    this.code = code;
  }
}

class LowLiquidityAlertError extends HotWalletPoolError {
  constructor(message, details = {}) {
    super(message, 'LOW_LIQUIDITY_ALERT');
    this.details = details;
  }
}

class BalanceCapExceededError extends HotWalletPoolError {
  constructor(message, details = {}) {
    super(message, 'BALANCE_CAP_EXCEEDED');
    this.details = details;
  }
}

class ReplenishmentError extends HotWalletPoolError {
  constructor(message, cause = null) {
    super(message, 'REPLENISHMENT_FAILED');
    this.cause = cause;
  }
}

/**
 * Ephemeral Hot Wallet Pool with Automated Replenishment from Cold Storage.
 * 
 * Addresses the operational security risk of funding user accounts from a single
 * large hot wallet. Maintains a pool of ephemeral, low-balance hot wallets capped
 * at maxBalanceXlm (< 500 XLM). When liquidity dips below minBalanceXlm, automated
 * alerts fire and multi-sig replenishment transactions from cold storage are executed.
 */
class HotWalletPool {
  constructor({
    coldStoragePublicKey,
    coldStorageSigners = [], // array of Keypairs or secrets
    coldStorageThreshold = DEFAULT_MULTISIG_REQUIRED_WEIGHT,
    server = null,
    networkPassphrase = null,
    poolSize = DEFAULT_POOL_SIZE,
    maxBalanceXlm = DEFAULT_MAX_BALANCE_XLM,
    minBalanceXlm = DEFAULT_MIN_BALANCE_XLM,
    targetReplenishXlm = DEFAULT_TARGET_REPLENISH_XLM,
    onAlert = null,
    initialWallets = null,
  } = {}) {
    if (!coldStoragePublicKey && (!Array.isArray(coldStorageSigners) || coldStorageSigners.length === 0)) {
      throw new HotWalletPoolError('Cold storage public key or signers are required for multi-sig replenishment');
    }

    this.server = server;
    this.networkPassphrase = networkPassphrase || (
      config.stellar?.networkPassphrase ||
      (config.stellar?.network === 'mainnet' || config.stellar?.network === 'public'
        ? StellarSdk.Networks.PUBLIC
        : StellarSdk.Networks.TESTNET)
    );

    this.coldStorageSigners = (coldStorageSigners || []).map((s) => (
      typeof s === 'string' ? StellarSdk.Keypair.fromSecret(s) : s
    ));

    this.coldStoragePublicKey = coldStoragePublicKey || (
      this.coldStorageSigners[0]?.publicKey()
    );

    this.coldStorageThreshold = Math.max(1, Number(coldStorageThreshold) || DEFAULT_MULTISIG_REQUIRED_WEIGHT);
    this.maxBalanceXlm = Math.max(10.0, Number(maxBalanceXlm) || DEFAULT_MAX_BALANCE_XLM);
    this.minBalanceXlm = Math.max(1.0, Number(minBalanceXlm) || DEFAULT_MIN_BALANCE_XLM);

    // Ensure target replenishment respects the balance cap
    const requestedTarget = Number(targetReplenishXlm) || DEFAULT_TARGET_REPLENISH_XLM;
    this.targetReplenishXlm = Math.min(requestedTarget, this.maxBalanceXlm - 1.0);

    this.poolSize = Math.max(1, Number(poolSize) || DEFAULT_POOL_SIZE);
    this.onAlert = typeof onAlert === 'function' ? onAlert : null;

    this.alertsFired = [];
    this.replenishmentHistory = [];
    this._lockTail = Promise.resolve();

    // Initialize hot wallets
    this._wallets = [];
    if (Array.isArray(initialWallets) && initialWallets.length > 0) {
      initialWallets.forEach((w, idx) => {
        const kp = typeof w.secret === 'string' ? StellarSdk.Keypair.fromSecret(w.secret) : (w.keypair || StellarSdk.Keypair.random());
        this._wallets.push(this._createWalletRecord(`hot-wallet-${idx}`, kp, Number(w.balanceXlm || 0)));
      });
    } else {
      for (let i = 0; i < this.poolSize; i++) {
        const kp = StellarSdk.Keypair.random();
        this._wallets.push(this._createWalletRecord(`hot-wallet-${i}`, kp, this.targetReplenishXlm));
      }
    }
  }

  _createWalletRecord(id, keypair, balanceXlm = 0) {
    if (balanceXlm > this.maxBalanceXlm) {
      throw new BalanceCapExceededError(
        `Initial balance ${balanceXlm} XLM exceeds maximum cap of ${this.maxBalanceXlm} XLM`,
        { balanceXlm, maxBalanceXlm: this.maxBalanceXlm }
      );
    }

    return {
      id,
      keypair,
      publicKey: keypair.publicKey(),
      balanceXlm: Number(balanceXlm.toFixed(7)),
      status: 'active', // 'active' | 'in_use' | 'retired'
      disbursementsCount: 0,
      totalDisbursedXlm: 0,
      lastReplenishedAt: Date.now(),
      createdAt: Date.now(),
    };
  }

  /**
   * Fires an alert when liquidity dips below safety threshold or pool anomaly occurs.
   */
  _fireAlert(type, payload) {
    const alertRecord = {
      type,
      timestamp: Date.now(),
      payload,
    };
    this.alertsFired.push(alertRecord);

    logger.warn('hot_wallet_low_liquidity_alert', {
      type,
      ...payload,
    });

    if (this.onAlert) {
      try {
        this.onAlert(alertRecord);
      } catch (err) {
        logger.error('hot_wallet_alert_callback_failed', { error: err.message });
      }
    }
  }

  /**
   * Acquire an active hot wallet with sufficient balance for a disbursement.
   */
  async acquireWallet({ minAmountXlm = 0 } = {}) {
    const active = this._wallets.filter((w) => w.status === 'active');
    if (active.length === 0) {
      this._fireAlert('pool_exhausted', {
        reason: 'No active hot wallets available in pool',
        totalWallets: this._wallets.length,
      });
      throw new HotWalletPoolError('Hot wallet pool is exhausted; no active wallets available', 'POOL_EXHAUSTED');
    }

    // Pick wallet with best balance that has enough for the disbursement
    const sorted = [...active].sort((a, b) => b.balanceXlm - a.balanceXlm);
    const chosen = sorted.find((w) => w.balanceXlm >= minAmountXlm);

    if (!chosen) {
      const highestBalance = sorted[0]?.balanceXlm || 0;
      this._fireAlert('insufficient_liquidity', {
        requiredXlm: minAmountXlm,
        highestAvailableXlm: highestBalance,
        activeWalletsCount: active.length,
      });
      throw new LowLiquidityAlertError(
        `Insufficient hot wallet liquidity: needed ${minAmountXlm} XLM, best available is ${highestBalance} XLM`,
        { requiredXlm: minAmountXlm, highestAvailableXlm: highestBalance }
      );
    }

    chosen.status = 'in_use';
    return {
      id: chosen.id,
      publicKey: chosen.publicKey,
      keypair: chosen.keypair,
      balanceXlm: chosen.balanceXlm,
    };
  }

  /**
   * Release wallet back to pool after transaction and trigger auto-replenishment if low.
   */
  async releaseWallet(walletId, { newBalanceXlm = null, amountDeductedXlm = null } = {}) {
    const wallet = this._wallets.find((w) => w.id === walletId);
    if (!wallet) {
      throw new HotWalletPoolError(`Unknown wallet ${walletId}`, 'WALLET_NOT_FOUND');
    }

    if (newBalanceXlm !== null) {
      wallet.balanceXlm = Number(Number(newBalanceXlm).toFixed(7));
    } else if (amountDeductedXlm !== null) {
      wallet.balanceXlm = Math.max(0, Number((wallet.balanceXlm - Number(amountDeductedXlm)).toFixed(7)));
      wallet.disbursementsCount += 1;
      wallet.totalDisbursedXlm = Number((wallet.totalDisbursedXlm + Number(amountDeductedXlm)).toFixed(7));
    }

    wallet.status = 'active';

    // Verify balance cap is respected
    if (wallet.balanceXlm > this.maxBalanceXlm) {
      logger.warn('hot_wallet_balance_exceeded_cap', {
        walletId,
        balanceXlm: wallet.balanceXlm,
        maxBalanceXlm: this.maxBalanceXlm,
      });
    }

    // Check if balance dipped below safety threshold
    if (wallet.balanceXlm < this.minBalanceXlm) {
      this._fireAlert('low_liquidity', {
        walletId: wallet.id,
        publicKey: wallet.publicKey,
        balanceXlm: wallet.balanceXlm,
        thresholdXlm: this.minBalanceXlm,
      });

      // Automatically trigger multi-sig replenishment
      await this.replenishWallet(wallet.id);
    }

    return wallet;
  }

  /**
   * Triggers a multi-sig replenishment transaction from cold storage to top up a hot wallet.
   * Enforces that the resulting balance never exceeds maxBalanceXlm (< 500 XLM).
   */
  async replenishWallet(walletId, { amountXlm = null } = {}) {
    const wallet = this._wallets.find((w) => w.id === walletId);
    if (!wallet) {
      throw new HotWalletPoolError(`Wallet ${walletId} not found`, 'WALLET_NOT_FOUND');
    }

    // Determine safe top-up amount
    let topUpAmount;
    if (amountXlm !== null) {
      topUpAmount = Number(amountXlm);
    } else {
      topUpAmount = Math.max(0, this.targetReplenishXlm - wallet.balanceXlm);
    }

    if (topUpAmount <= 0) {
      return { replenished: false, balanceXlm: wallet.balanceXlm, reason: 'Already at or above target' };
    }

    // Check balance cap constraint
    if (wallet.balanceXlm + topUpAmount > this.maxBalanceXlm) {
      topUpAmount = Number((this.maxBalanceXlm - wallet.balanceXlm).toFixed(7));
      if (topUpAmount <= 0) {
        throw new BalanceCapExceededError(
          `Cannot replenish: wallet ${walletId} is at balance cap (${this.maxBalanceXlm} XLM)`,
          { walletId, balanceXlm: wallet.balanceXlm, maxBalanceXlm: this.maxBalanceXlm }
        );
      }
    }

    // Build and execute multi-sig transaction from cold storage
    const replenishmentTx = await this._executeMultisigTransfer({
      destination: wallet.publicKey,
      amountXlm: topUpAmount,
    });

    wallet.balanceXlm = Number((wallet.balanceXlm + topUpAmount).toFixed(7));
    wallet.lastReplenishedAt = Date.now();

    const record = {
      walletId: wallet.id,
      publicKey: wallet.publicKey,
      amountXlm: topUpAmount,
      newBalanceXlm: wallet.balanceXlm,
      txHash: replenishmentTx.hash,
      timestamp: Date.now(),
    };
    this.replenishmentHistory.push(record);

    logger.info('hot_wallet_replenished_from_cold_storage', record);

    return {
      replenished: true,
      ...record,
    };
  }

  /**
   * Executes a multi-sig transaction from cold storage, gathering required signatures.
   */
  async _executeMultisigTransfer({ destination, amountXlm }) {
    if (this.coldStorageSigners.length < this.coldStorageThreshold) {
      throw new ReplenishmentError(
        `Insufficient cold storage signers: have ${this.coldStorageSigners.length}, required ${this.coldStorageThreshold}`
      );
    }

    // If a real or mock Horizon server is provided
    if (this.server && typeof this.server.loadAccount === 'function') {
      try {
        const coldAccount = await this.server.loadAccount(this.coldStoragePublicKey);
        const tx = new StellarSdk.TransactionBuilder(coldAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            StellarSdk.Operation.payment({
              destination,
              asset: StellarSdk.Asset.native(),
              amount: amountXlm.toFixed(7),
            })
          )
          .setTimeout(30)
          .build();

        // Multi-sig signing: apply signatures from cold storage signers up to required threshold
        for (let i = 0; i < this.coldStorageThreshold; i++) {
          tx.sign(this.coldStorageSigners[i]);
        }

        const res = await this.server.submitTransaction(tx);
        return { hash: res.hash || tx.hash().toString('hex'), tx };
      } catch (err) {
        throw new ReplenishmentError(`Failed to execute multi-sig replenishment on Horizon: ${err.message}`, err);
      }
    }

    // In-memory / simulated multi-sig transaction
    const coldAccount = new StellarSdk.Account(this.coldStoragePublicKey, '100');
    const tx = new StellarSdk.TransactionBuilder(coldAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination,
          asset: StellarSdk.Asset.native(),
          amount: amountXlm.toFixed(7),
        })
      )
      .setTimeout(30)
      .build();

    for (let i = 0; i < this.coldStorageThreshold; i++) {
      tx.sign(this.coldStorageSigners[i]);
    }

    return {
      hash: tx.hash().toString('hex'),
      tx,
    };
  }

  /**
   * Rotates an ephemeral hot wallet: marks the old one as retired and introduces
   * a fresh, randomly generated hot wallet topped up from cold storage.
   */
  async rotateWallet(walletId) {
    const idx = this._wallets.findIndex((w) => w.id === walletId);
    if (idx === -1) {
      throw new HotWalletPoolError(`Wallet ${walletId} not found`, 'WALLET_NOT_FOUND');
    }

    const oldWallet = this._wallets[idx];
    oldWallet.status = 'retired';

    // Generate new ephemeral wallet
    const newKp = StellarSdk.Keypair.random();
    const newWallet = this._createWalletRecord(`hot-wallet-${Date.now()}`, newKp, 0);

    // Replace in pool
    this._wallets[idx] = newWallet;

    // Replenish new wallet from cold storage
    await this.replenishWallet(newWallet.id, { amountXlm: this.targetReplenishXlm });

    logger.info('hot_wallet_rotated', {
      retiredId: oldWallet.id,
      retiredPublicKey: oldWallet.publicKey,
      newId: newWallet.id,
      newPublicKey: newWallet.publicKey,
      fundedXlm: newWallet.balanceXlm,
    });

    return newWallet;
  }

  /**
   * Evaluates overall pool liquidity and triggers automated alerts & replenishment
   * for any wallets that have fallen below safety thresholds.
   */
  async checkPoolHealth() {
    const results = {
      totalWallets: this._wallets.length,
      activeWallets: 0,
      totalLiquidityXlm: 0,
      lowLiquidityWallets: [],
      replenishedCount: 0,
    };

    for (const wallet of this._wallets) {
      if (wallet.status !== 'retired') {
        results.activeWallets += 1;
        results.totalLiquidityXlm = Number((results.totalLiquidityXlm + wallet.balanceXlm).toFixed(7));

        if (wallet.balanceXlm < this.minBalanceXlm) {
          results.lowLiquidityWallets.push({
            id: wallet.id,
            publicKey: wallet.publicKey,
            balanceXlm: wallet.balanceXlm,
          });

          this._fireAlert('low_liquidity', {
            walletId: wallet.id,
            publicKey: wallet.publicKey,
            balanceXlm: wallet.balanceXlm,
            thresholdXlm: this.minBalanceXlm,
          });

          const rep = await this.replenishWallet(wallet.id);
          if (rep.replenished) {
            results.replenishedCount += 1;
          }
        }
      }
    }

    return results;
  }

  /**
   * Returns current pool status and metrics.
   */
  getStatus() {
    const totalLiquidityXlm = this._wallets
      .filter((w) => w.status !== 'retired')
      .reduce((sum, w) => sum + w.balanceXlm, 0);

    return {
      poolSize: this.poolSize,
      maxBalanceCapXlm: this.maxBalanceXlm,
      minBalanceThresholdXlm: this.minBalanceXlm,
      targetReplenishXlm: this.targetReplenishXlm,
      totalLiquidityXlm: Number(totalLiquidityXlm.toFixed(7)),
      activeWallets: this._wallets.map((w) => ({
        id: w.id,
        publicKey: w.publicKey,
        balanceXlm: w.balanceXlm,
        status: w.status,
        disbursementsCount: w.disbursementsCount,
        lastReplenishedAt: w.lastReplenishedAt,
      })),
      alertsCount: this.alertsFired.length,
      replenishmentsCount: this.replenishmentHistory.length,
    };
  }
}

module.exports = {
  HotWalletPool,
  HotWalletPoolError,
  LowLiquidityAlertError,
  BalanceCapExceededError,
  ReplenishmentError,
  DEFAULT_MAX_BALANCE_XLM,
  DEFAULT_MIN_BALANCE_XLM,
  DEFAULT_TARGET_REPLENISH_XLM,
};
