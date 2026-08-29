/**
 * Service: Payment Idempotency & Duplicate Settlement Service (#336)
 *
 * Handles idempotency key generation, duplicate payment instruction detection,
 * settlement attempt tracking against payment identities, and safe retry execution policies.
 */

class PaymentIdempotencyService {
  constructor() {
    this.instructionStore = new Map();
    this.settlementAttempts = new Map();
  }

  /**
   * Generates or validates an idempotency key for a payment instruction.
   * @param {Object} params
   * @param {string} [params.idempotencyKey]
   * @param {string} params.senderId
   * @param {string} params.recipientAddress
   * @param {number|string} params.amount
   * @param {string} [params.assetCode]
   * @returns {string}
   */
  getOrGenerateKey({ idempotencyKey, senderId, recipientAddress, amount, assetCode = 'XLM' }) {
    if (idempotencyKey && String(idempotencyKey).trim()) {
      return String(idempotencyKey).trim();
    }
    return `ik_${senderId}_${recipientAddress}_${amount}_${assetCode}`;
  }

  /**
   * Registers a payment instruction attempt.
   * Returns { isDuplicate: false } for new instructions, or { isDuplicate: true, existingRecord } for duplicates.
   */
  processInstruction(instruction) {
    const key = this.getOrGenerateKey(instruction);
    const now = new Date().toISOString();

    if (this.instructionStore.has(key)) {
      const existing = this.instructionStore.get(key);
      const attemptCount = (existing.attemptCount || 1) + 1;
      existing.attemptCount = attemptCount;
      existing.lastAttemptAt = now;

      // Track execution history
      this.recordSettlementAttempt(key, {
        attemptNumber: attemptCount,
        status: 'DUPLICATE_REJECTED',
        timestamp: now,
        reason: 'Duplicate payment instruction received for active key',
      });

      return {
        isDuplicate: true,
        idempotencyKey: key,
        existingRecord: existing,
        message: 'Duplicate payment instruction recognized and safely handled.',
      };
    }

    const record = {
      idempotencyKey: key,
      paymentId: instruction.paymentId || `pay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      senderId: instruction.senderId,
      recipientAddress: instruction.recipientAddress,
      amount: instruction.amount,
      assetCode: instruction.assetCode || 'XLM',
      status: 'PENDING',
      attemptCount: 1,
      createdAt: now,
      lastAttemptAt: now,
    };

    this.instructionStore.set(key, record);
    this.recordSettlementAttempt(key, {
      attemptNumber: 1,
      status: 'INITIATED',
      timestamp: now,
    });

    return {
      isDuplicate: false,
      idempotencyKey: key,
      record,
    };
  }

  /**
   * Records a settlement attempt for a payment identity.
   */
  recordSettlementAttempt(idempotencyKey, attemptData) {
    const history = this.settlementAttempts.get(idempotencyKey) || [];
    history.push({
      attemptId: `att_${Date.now()}_${history.length + 1}`,
      ...attemptData,
    });
    this.settlementAttempts.set(idempotencyKey, history);
  }

  /**
   * Updates the final status of a payment instruction and its settlement record.
   */
  updateStatus(idempotencyKey, status, metadata = {}) {
    const record = this.instructionStore.get(idempotencyKey);
    if (record) {
      record.status = status;
      record.updatedAt = new Date().toISOString();
      record.metadata = { ...record.metadata, ...metadata };

      this.recordSettlementAttempt(idempotencyKey, {
        attemptNumber: record.attemptCount,
        status,
        timestamp: record.updatedAt,
        metadata,
      });
    }
    return record;
  }

  /**
   * Retrieves full settlement history and attempts for a payment key.
   */
  getSettlementTrace(idempotencyKey) {
    return {
      instruction: this.instructionStore.get(idempotencyKey) || null,
      attempts: this.settlementAttempts.get(idempotencyKey) || [],
    };
  }
}

const paymentIdempotencyService = new PaymentIdempotencyService();

module.exports = {
  PaymentIdempotencyService,
  paymentIdempotencyService,
};
