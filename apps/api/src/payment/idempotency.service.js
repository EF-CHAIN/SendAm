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
    ...(input.destinationAsset === undefined ? {} : { destinationAsset: input.destinationAsset }),
    ...(input.destinationAmount === undefined ? {} : { destinationAmount: input.destinationAmount }),
    ...(input.quoteId === undefined ? {} : { quoteId: input.quoteId }),
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
    amount: transaction.metadata?.pathPayment?.sourceDebit || transaction.amount,
    asset: transaction.asset,
    rail: transaction.rail,
    receiptUrl: transaction.explorerUrl,
    ...(transaction.txHash ? { txHash: transaction.txHash } : {}),
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

  // Row-level mutex on the idempotency record, same shape as loadUserForUpdate
  // in pin.service.js: SELECT ... FOR UPDATE inside a transaction when the
  // client supports it, plain read otherwise (unit-test stubs). The lock is
  // held only for the claim/complete decision, never across the payment run.
  const lockIdempotencyRow = async (client, userId, key) => {
    if (typeof client.$queryRaw === 'function') {
      try {
        const rows = await client.$queryRaw`
          SELECT "id", "fingerprint", "state", "leaseExpiresAt", "reservedTransactionId"
          FROM "PaymentIdempotency"
          WHERE "userId" = ${userId} AND "operation" = ${OPERATION} AND "key" = ${key}
          FOR UPDATE
        `;
        if (rows && rows.length > 0) return rows[0];
        return null;
      } catch (_error) {
        // Fall through to the standard Prisma read.
      }
    }
    return client.paymentIdempotency.findUnique({
      where: { userId_operation_key: { userId, operation: OPERATION, key } },
    });
  };

  const withIdempotencyLock = async (userId, key, fn) => {
    if (typeof db.$transaction === 'function') {
      return db.$transaction(async (tx) => fn(tx, await lockIdempotencyRow(tx, userId, key)));
    }
    return fn(db, await lockIdempotencyRow(db, userId, key));
  };

  // Recover an expired lease atomically: lock the row, re-check it under the
  // lock, and claim it only when the lease really is expired and no financial
  // transaction exists for it yet. The old bare updateMany checked neither:
  // its comment promised "only if its transaction row still does not exist"
  // but the WHERE clause never verified that.
  const claimExpiredLease = async ({ userId, key, fingerprint }) => {
    const nowTime = now();
    return withIdempotencyLock(userId, key, async (tx, locked) => {
      if (!locked || locked.fingerprint !== fingerprint || locked.state !== 'processing') return false;
      if (new Date(locked.leaseExpiresAt).getTime() > nowTime.getTime()) return false;
      if (typeof tx.transaction?.findUnique === 'function') {
        const existing = await tx.transaction.findUnique({ where: { id: locked.reservedTransactionId } });
        if (existing) return false;
      }
      const renewed = await tx.paymentIdempotency.updateMany({
        where: {
          id: locked.id,
          fingerprint,
          state: 'processing',
          leaseExpiresAt: { lte: now() },
        },
        data: { leaseExpiresAt: new Date(now().getTime() + LEASE_MS) },
      });
      return renewed.count === 1;
    });
  };

  // Persist the Stellar hash on the transaction row when the run returned one
  // but the row does not have it yet. Conditional so an existing hash is
  // never overwritten. Best effort; completion must not fail over this.
  const storeTransactionHash = async (response) => {
    const txHash = response?.transaction?.txHash || response?.receipt?.txHash || response?.txHash || null;
    const txId = response?.transaction?.id || response?.transactionId || null;
    if (!txHash || !txId || typeof db.transaction?.updateMany !== 'function') return;
    await db.transaction.updateMany({
      where: { id: txId, txHash: null },
      data: { txHash },
    }).catch(() => null);
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
        // Compare-and-set: only the first execution to settle this key may
        // write the completed response. If another one won, loop and re-read
        // the recorded outcome instead of overwriting it.
        const settled = await db.paymentIdempotency.updateMany({
          where: { id: record.id, state: 'processing' },
          data: { state: 'completed', response },
        });
        if (settled.count === 1) return response;
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
      const claimed = await claimExpiredLease({ userId, key, fingerprint });
      if (!claimed) {
        const retry = await replayOrWait({ userId, key, fingerprint });
        if (retry) return { response: retry, replayed: true };
        throw new IdempotencyError('The original payment is still processing; retry this key later', 409);
      }
      record = await read(userId, key);
      if (!record) {
        throw new IdempotencyError('The original payment is still processing; retry this key later', 409);
      }
    }

    let response;
    try {
      response = await run({ transactionId: record.reservedTransactionId });
    } catch (error) {
      await db.paymentIdempotency.updateMany({
        where: { id: record.id, state: 'processing' },
        data: {
          state: 'failed',
          response: { message: error.message || 'Payment failed', statusCode: error.statusCode || 500 },
        },
      }).catch(() => null);
      throw error;
    }

    // The run result carries the transaction object (withIdAlias adds _id,
    // not transactionId), so take the id from there. The old code stored
    // response.transactionId, which is undefined here, so the record was
    // never linked to its transaction.
    const completedTransactionId = response?.transaction?.id || response?.transactionId || null;
    // Compare-and-set: only settle this key while it is still processing. If
    // another execution settled it first, return its outcome instead of
    // overwriting it, so concurrent requests get identical results.
    const settled = await db.paymentIdempotency.updateMany({
      where: { id: record.id, state: 'processing' },
      data: {
        state: 'completed',
        response,
        ...(completedTransactionId ? { transactionId: completedTransactionId } : {}),
      },
    });
    if (settled.count === 1) {
      await storeTransactionHash(response);
      return { response, replayed: false };
    }
    const replay = await replayOrWait({ userId, key, fingerprint });
    if (replay) return { response: replay, replayed: true };
    throw new IdempotencyError('The original payment is still processing; retry this key later', 409);
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

