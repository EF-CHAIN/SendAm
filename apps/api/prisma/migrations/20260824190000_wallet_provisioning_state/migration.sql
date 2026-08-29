ALTER TABLE "Wallet"
  ADD COLUMN "fundingState" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "fundingAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fundingError" TEXT,
  ADD COLUMN "fundingUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "trustlineState" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "trustlineAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "trustlineError" TEXT,
  ADD COLUMN "trustlineUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Wallet"
SET "fundingState" = CASE WHEN "funded" THEN 'succeeded' ELSE 'pending' END,
    "trustlineState" = CASE WHEN "funded" THEN 'pending' ELSE 'blocked' END;

CREATE INDEX "Wallet_fundingState_fundingUpdatedAt_idx" ON "Wallet"("fundingState", "fundingUpdatedAt");
CREATE INDEX "Wallet_trustlineState_trustlineUpdatedAt_idx" ON "Wallet"("trustlineState", "trustlineUpdatedAt");
