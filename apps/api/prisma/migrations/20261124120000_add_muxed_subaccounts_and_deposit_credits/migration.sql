-- #958 — Virtual sub-wallets addressed by MED25519 muxed addresses.
-- Every sub-account shares the underlying base account's reserves and
-- trustlines; this table is only the off-chain id -> user mapping.
CREATE TABLE "MuxedSubAccount" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "userId"      TEXT NOT NULL,
  "walletId"    TEXT NOT NULL,
  -- uint64 held as a decimal string: a JS Number cannot represent 2^64-1.
  "muxedId"     TEXT NOT NULL,
  "baseAccount" TEXT NOT NULL,
  "network"     TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MuxedSubAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MuxedSubAccount_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MuxedSubAccount_baseAccount_muxedId_key" ON "MuxedSubAccount"("baseAccount", "muxedId");
CREATE INDEX "MuxedSubAccount_userId_idx" ON "MuxedSubAccount"("userId");
CREATE INDEX "MuxedSubAccount_walletId_idx" ON "MuxedSubAccount"("walletId");

-- #958 — Exactly-once deposit crediting. The unique Horizon paging token is
-- the idempotency key that stops a replayed cursor double-crediting a user.
CREATE TABLE "DepositCredit" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "stellarPaymentId" TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "walletId"         TEXT NOT NULL,
  "muxedId"          TEXT,
  "asset"            TEXT NOT NULL,
  "assetIssuer"      TEXT,
  "amount"           TEXT NOT NULL,
  "network"          TEXT NOT NULL,
  "journalEntryId"   TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DepositCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DepositCredit_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DepositCredit_stellarPaymentId_key" ON "DepositCredit"("stellarPaymentId");
CREATE INDEX "DepositCredit_userId_createdAt_idx" ON "DepositCredit"("userId", "createdAt");
CREATE INDEX "DepositCredit_walletId_createdAt_idx" ON "DepositCredit"("walletId", "createdAt");
