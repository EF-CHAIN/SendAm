const crypto = require('crypto');
const prisma = require('../common/prisma');

const OPERATION = 'wallet.send';
const RETENTION_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 30 * 1000;
const WAIT_MS = 30 * 1000;
const POLL_MS = 100;

class IdempotencyError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'IdempotencyError';
    this.statusCode = statusCode;
  }
}

const validateKey = (key) => (
  typeof key === 'string'
  && key.length >= 8
  && key.length <= 128
  && /^[A-Za-z0-9._:-]+$/.test(key)
);

const fingerprintRequest = (input) => {
  const canonical = {
    amount: String(input.amount),
    asset: String(input.asset || 'XLM').toUpperCase(),
    destination: String(input.destination).trim(),
    destinationCountry: String(input.destinationCountry || 'NG').toUpperCase(),
    routeType: input.routeType || null,
    sourceCountry: String(input.sourceCountry || 'NG').toUpperCase(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const responseFromTransaction = (transaction) => ({
  transactionId: transaction.id,
  status: transaction.status,
  rail: transaction.rail,
  receipt: {
    transactionId: transaction.id,
    status: transaction.status,
    amount: transaction.amount,
    asset: transaction.asset,
    rail: transaction.rail,
    receiptUrl: transaction.explorerUrl,
  },
});

const createIdempotencyService = (db = prisma, { now = () => new Date(), wait = sleep } = {}) => {
  const read = async (userId, key) => {
    const record = await db.paymentIdempotency.findUnique({
      where: { userId_operation_key: { userId, operation: OPERATION, key } },
      include: { transaction: true },
    });
    if (record && !record.transaction && db.transaction) {
      record.transaction = await db.transaction.findUnique({ where: { id: record.reservedTransactionId } });
    }
    return record;
  };

  const replayOrWait = async ({ userId, key, fingerprint }) => {
    const deadline = Date.now() + WAIT_MS;
    do {
      const record = await read(userId, key);
      if (!record) return null;
      if (record.fingerprint !== fingerprint) {
        throw new IdempotencyError('Idempotency key was already used with a different payment request', 409);
      }
      if (record.state === 'completed' && record.response) return record.response;
      if (record.state === 'failed') {
        throw new IdempotencyError(record.response?.message || 'The original payment attempt failed', record.response?.statusCode || 409);
      }
      if (record.transaction?.status === 'success') {
        const response = responseFromTransaction(record.transaction);
        await db.paymentIdempotency.update({ where: { id: record.id }, data: { state: 'completed', response } });
        return response;
      }
      if (record.transaction && ['failed', 'rejected'].includes(record.transaction.status)) {
        throw new IdempotencyError('The original payment attempt failed', 409);
      }

      // A lease may be recovered only when there is no financial transaction.
      // If one exists in processing state, reconciliation must settle it first;
      // rerunning could submit a second Stellar payment.
      if (record.leaseExpiresAt <= now() && !record.transaction) return null;
      if (Date.now() < deadline) await wait(POLL_MS);
    } while (Date.now() < deadline);

    throw new IdempotencyError('The original payment is still processing; retry this key later', 409);
  };

  const execute = async ({ userId, key, fingerprint, run }) => {
    const currentTime = now();
    const transactionId = crypto.randomUUID();
    let record;
    let owner = false;

    try {
      record = await db.paymentIdempotency.create({
        data: {
          userId,
          operation: OPERATION,
          key,
          fingerprint,
          reservedTransactionId: transactionId,
          leaseExpiresAt: new Date(currentTime.getTime() + LEASE_MS),
          expiresAt: new Date(currentTime.getTime() + RETENTION_MS),
        },
      });
      owner = true;
    } catch (error) {
      if (error.code !== 'P2002') throw error;
    }

    if (!owner) {
      const replay = await replayOrWait({ userId, key, fingerprint });
      if (replay) return { response: replay, replayed: true };

      // Claim an expired request only if its transaction row still does not
      // exist. Reuse its reserved transaction ID to close the recovery race.
      record = await read(userId, key);
      const claimed = await db.paymentIdempotency.updateMany({
        where: {
          id: record.id,
          fingerprint,
          state: 'processing',
          leaseExpiresAt: { lte: now() },
        },
        data: { leaseExpiresAt: new Date(now().getTime() + LEASE_MS) },
      });
      if (claimed.count !== 1) {
        const replay = await replayOrWait({ userId, key, fingerprint });
        return { response: replay, replayed: true };
      }
    }

    try {
      const response = await run({ transactionId: record.reservedTransactionId });
      await db.paymentIdempotency.update({
        where: { id: record.id },
        data: { state: 'completed', response, transactionId: response.transactionId },
      });
      return { response, replayed: false };
    } catch (error) {
      await db.paymentIdempotency.update({
        where: { id: record.id },
        data: {
          state: 'failed',
          response: { message: error.message || 'Payment failed', statusCode: error.statusCode || 500 },
        },
      }).catch(() => null);
      throw error;
    }
  };

  return { execute };
};

class PaymentIdempotencyService {
  constructor() {
    this.instructionStore = new Map();
    this.settlementAttempts = new Map();
  }

  getOrGenerateKey({ idempotencyKey, senderId, recipientAddress, amount, assetCode = 'XLM' }) {
    if (idempotencyKey && String(idempotencyKey).trim()) {
      return String(idempotencyKey).trim();
    }
    return `ik_${senderId}_${recipientAddress}_${amount}_${assetCode}`;
  }

  processInstruction(instruction) {
    const key = this.getOrGenerateKey(instruction);
    const now = new Date().toISOString();

    if (this.instructionStore.has(key)) {
      const existing = this.instructionStore.get(key);
      const attemptCount = (existing.attemptCount || 1) + 1;
      existing.attemptCount = attemptCount;
      existing.lastAttemptAt = now;

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

  recordSettlementAttempt(idempotencyKey, attemptData) {
    const history = this.settlementAttempts.get(idempotencyKey) || [];
    history.push({
      attemptId: `att_${Date.now()}_${history.length + 1}`,
      ...attemptData,
    });
    this.settlementAttempts.set(idempotencyKey, history);
  }

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

  getSettlementTrace(idempotencyKey) {
    return {
      instruction: this.instructionStore.get(idempotencyKey) || null,
      attempts: this.settlementAttempts.get(idempotencyKey) || [],
    };
  }
}

const paymentIdempotencyService = new PaymentIdempotencyService();

module.exports = {
  IdempotencyError,
  validateKey,
  fingerprintRequest,
  createIdempotencyService,
  idempotencyService: createIdempotencyService(),
  PaymentIdempotencyService,
  paymentIdempotencyService,
};

