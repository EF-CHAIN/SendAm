CREATE TABLE "FeeVoucher" (
  "earnedById" TEXT NOT NULL,
  "redeemedById" TEXT,
  "userId" TEXT NOT NULL,
  "asset" TEXT NOT NULL,
  "amount" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeeVoucher_pkey" PRIMARY KEY ("earnedById"),
  CONSTRAINT "FeeVoucher_earnedById_fkey" FOREIGN KEY ("earnedById") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FeeVoucher_redeemedById_fkey" FOREIGN KEY ("redeemedById") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FeeVoucher_redeemedById_key" ON "FeeVoucher"("redeemedById");
CREATE INDEX "FeeVoucher_userId_asset_createdAt_idx" ON "FeeVoucher"("userId", "asset", "createdAt");
