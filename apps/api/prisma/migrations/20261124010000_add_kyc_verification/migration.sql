-- Tier-1 BVN/NIN verification attempts (#982). The raw ID number is never stored: idHash is an HMAC.
-- CreateTable
CREATE TABLE "KycVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "idType" TEXT NOT NULL,
    "idHash" TEXT NOT NULL,
    "idLast4" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "providerReference" TEXT,
    "failureReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KycVerification_userId_createdAt_idx" ON "KycVerification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "KycVerification_idHash_status_idx" ON "KycVerification"("idHash", "status");

-- CreateIndex
CREATE INDEX "KycVerification_providerReference_provider_idx" ON "KycVerification"("providerReference", "provider");

-- AddForeignKey
ALTER TABLE "KycVerification" ADD CONSTRAINT "KycVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
