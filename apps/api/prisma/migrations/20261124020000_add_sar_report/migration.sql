-- Automated Suspicious Activity Reporting (SAR) draft tracking (#986).
-- CreateTable
CREATE TABLE "SarReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reportNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reason" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "transactionIds" TEXT[],
    "totalAmountUsd" DECIMAL(65,30) NOT NULL,
    "detectionRule" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SarReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SarReport_reportNumber_key" ON "SarReport"("reportNumber");

-- CreateIndex
CREATE INDEX "SarReport_userId_createdAt_idx" ON "SarReport"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SarReport_status_idx" ON "SarReport"("status");

-- CreateIndex
CREATE INDEX "SarReport_detectionRule_idx" ON "SarReport"("detectionRule");

-- AddForeignKey
ALTER TABLE "SarReport" ADD CONSTRAINT "SarReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
