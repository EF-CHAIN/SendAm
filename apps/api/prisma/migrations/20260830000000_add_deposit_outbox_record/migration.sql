-- Creates the DepositOutboxRecord table. The model has existed in
-- schema.prisma but no migration ever created it, so `prisma migrate deploy`
-- fails on a fresh database as soon as a later migration (canonical stellar
-- asset identity) tries to ALTER TABLE "DepositOutboxRecord".
--
-- "assetIssuer", "network", and "trusted" are deliberately omitted here: the
-- later 20260831180000_canonical_stellar_asset_identity migration ADD COLUMNs
-- them, so declaring them in this CREATE TABLE would make that migration fail
-- with "column already exists".
CREATE TABLE "DepositOutboxRecord" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "stellarPaymentId"  TEXT NOT NULL,
  "walletId"          TEXT NOT NULL,
  "userId"            TEXT,
  "phoneNumber"       TEXT NOT NULL,
  "amount"            TEXT NOT NULL,
  "asset"             TEXT NOT NULL,
  "fiatRate"          DOUBLE PRECISION,
  "message"           TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "maxAttempts"       INTEGER NOT NULL DEFAULT 5,
  "lastError"         TEXT,
  "providerMessageId" TEXT,
  "deliveredAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "DepositOutboxRecord_stellarPaymentId_key" ON "DepositOutboxRecord"("stellarPaymentId");
CREATE INDEX "DepositOutboxRecord_status_createdAt_idx" ON "DepositOutboxRecord"("status", "createdAt");
CREATE INDEX "DepositOutboxRecord_walletId_idx" ON "DepositOutboxRecord"("walletId");
CREATE INDEX "DepositOutboxRecord_stellarPaymentId_idx" ON "DepositOutboxRecord"("stellarPaymentId");
