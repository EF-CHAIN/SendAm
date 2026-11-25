-- Risk scoring feature extractor (#992): per-attempt assessments and an IP reputation cache.
-- CreateTable
CREATE TABLE "IpReputationCache" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IpReputationCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskAssessment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "riskClass" TEXT NOT NULL,
    "factors" JSONB NOT NULL,
    "reasons" TEXT[],
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IpReputationCache_ip_key" ON "IpReputationCache"("ip");

-- CreateIndex
CREATE INDEX "IpReputationCache_updatedAt_idx" ON "IpReputationCache"("updatedAt");

-- CreateIndex
CREATE INDEX "RiskAssessment_userId_createdAt_idx" ON "RiskAssessment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskAssessment_score_idx" ON "RiskAssessment"("score");

-- CreateIndex
CREATE INDEX "RiskAssessment_action_idx" ON "RiskAssessment"("action");

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
