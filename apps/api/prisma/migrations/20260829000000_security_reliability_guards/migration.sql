-- Immutable, nonce-bound WhatsApp confirmations and persisted REST
-- idempotency records. pendingSend remains temporarily for rolling-deploy
-- compatibility but is no longer read or written by the confirmation flow.
ALTER TABLE "User" ADD COLUMN "confirmationVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PaymentIdempotency" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'processing',
    "response" JSONB,
    "reservedTransactionId" TEXT NOT NULL,
    "transactionId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentConfirmation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "summaryHash" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "recipientLabel" TEXT,
    "routeType" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "authorizedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentIdempotency_transactionId_key" ON "PaymentIdempotency"("transactionId");
CREATE UNIQUE INDEX "PaymentIdempotency_reservedTransactionId_key" ON "PaymentIdempotency"("reservedTransactionId");
CREATE UNIQUE INDEX "PaymentIdempotency_userId_operation_key_key" ON "PaymentIdempotency"("userId", "operation", "key");
CREATE INDEX "PaymentIdempotency_expiresAt_idx" ON "PaymentIdempotency"("expiresAt");
CREATE INDEX "PaymentIdempotency_state_leaseExpiresAt_idx" ON "PaymentIdempotency"("state", "leaseExpiresAt");
CREATE UNIQUE INDEX "PaymentConfirmation_nonce_key" ON "PaymentConfirmation"("nonce");
CREATE UNIQUE INDEX "PaymentConfirmation_transactionId_key" ON "PaymentConfirmation"("transactionId");
CREATE UNIQUE INDEX "PaymentConfirmation_userId_reference_key" ON "PaymentConfirmation"("userId", "reference");
CREATE UNIQUE INDEX "PaymentConfirmation_userId_version_key" ON "PaymentConfirmation"("userId", "version");
CREATE INDEX "PaymentConfirmation_userId_state_createdAt_idx" ON "PaymentConfirmation"("userId", "state", "createdAt");
CREATE INDEX "PaymentConfirmation_expiresAt_idx" ON "PaymentConfirmation"("expiresAt");

ALTER TABLE "PaymentIdempotency" ADD CONSTRAINT "PaymentIdempotency_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentIdempotency" ADD CONSTRAINT "PaymentIdempotency_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentConfirmation" ADD CONSTRAINT "PaymentConfirmation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentConfirmation" ADD CONSTRAINT "PaymentConfirmation_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
