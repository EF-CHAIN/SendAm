-- #962 — Tracked ChangeTrust submissions. The unique asset-identity key per
-- wallet is what prevents two concurrent transfers racing duplicate
-- ChangeTrust operations onto the ledger.
CREATE TABLE "TrustlineRequest" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "walletId"    TEXT NOT NULL,
  "assetCode"   TEXT NOT NULL,
  "assetIssuer" TEXT NOT NULL,
  "network"     TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'pending',
  "txHash"      TEXT,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "lastError"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrustlineRequest_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TrustlineRequest_walletId_assetCode_assetIssuer_key" ON "TrustlineRequest"("walletId", "assetCode", "assetIssuer");
CREATE INDEX "TrustlineRequest_status_updatedAt_idx" ON "TrustlineRequest"("status", "updatedAt");
