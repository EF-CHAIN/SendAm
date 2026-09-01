-- Sync the migration-produced database with the current Prisma schema.
--
-- Several schema changes were committed without a matching migration:
--   • KycApproval, SanctionsScreeningResult, DepositOutboxRecord models have no
--     CREATE TABLE migration (the seed and integration tests hit them)
--   • AuditLog.hash / previousHash (hash-chained audit trail) have no migration
--   • Agent / Escrow / CashoutLocation were removed from the schema but the
--     init migration still creates them
--   • AdminUser_mustChangePassword_idx was dropped from the schema
--   • WhatsappStatusEvent unique index name was normalized by Prisma
--
-- This migration applies the same DDL `prisma migrate dev` would have
-- generated so fresh `prisma migrate deploy` databases match the schema.

-- DropForeignKey
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_locationId_fkey";

-- DropForeignKey
ALTER TABLE "Escrow" DROP CONSTRAINT "Escrow_arbiterId_fkey";

-- DropForeignKey
ALTER TABLE "Escrow" DROP CONSTRAINT "Escrow_creatorId_fkey";

-- DropIndex
DROP INDEX "AdminUser_mustChangePassword_idx";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "hash" TEXT,
ADD COLUMN     "previousHash" TEXT;

-- DropTable
DROP TABLE "Agent";

-- DropTable
DROP TABLE "CashoutLocation";

-- DropTable
DROP TABLE "Escrow";

-- CreateTable
CREATE TABLE "SanctionsScreeningResult" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "listVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "matches" JSONB NOT NULL DEFAULT '[]',
    "screenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decisionOwner" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SanctionsScreeningResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycApproval" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "proposedChanges" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositOutboxRecord" (
    "id" TEXT NOT NULL,
    "stellarPaymentId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "fiatRate" DOUBLE PRECISION,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositOutboxRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SanctionsScreeningResult_profileId_screenedAt_idx" ON "SanctionsScreeningResult"("profileId", "screenedAt");

-- CreateIndex
CREATE INDEX "SanctionsScreeningResult_subjectId_screenedAt_idx" ON "SanctionsScreeningResult"("subjectId", "screenedAt");

-- CreateIndex
CREATE INDEX "SanctionsScreeningResult_status_screenedAt_idx" ON "SanctionsScreeningResult"("status", "screenedAt");

-- CreateIndex
CREATE INDEX "SanctionsScreeningResult_provider_listVersion_idx" ON "SanctionsScreeningResult"("provider", "listVersion");

-- CreateIndex
CREATE INDEX "KycApproval_profileId_idx" ON "KycApproval"("profileId");

-- CreateIndex
CREATE INDEX "KycApproval_status_idx" ON "KycApproval"("status");

-- CreateIndex
CREATE INDEX "KycApproval_requestedBy_idx" ON "KycApproval"("requestedBy");

-- CreateIndex
CREATE UNIQUE INDEX "DepositOutboxRecord_stellarPaymentId_key" ON "DepositOutboxRecord"("stellarPaymentId");

-- CreateIndex
CREATE INDEX "DepositOutboxRecord_status_createdAt_idx" ON "DepositOutboxRecord"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DepositOutboxRecord_walletId_idx" ON "DepositOutboxRecord"("walletId");

-- CreateIndex
CREATE INDEX "DepositOutboxRecord_stellarPaymentId_idx" ON "DepositOutboxRecord"("stellarPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_previousHash_key" ON "AuditLog"("previousHash");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_hash_key" ON "AuditLog"("hash");

-- AddForeignKey
ALTER TABLE "SanctionsScreeningResult" ADD CONSTRAINT "SanctionsScreeningResult_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "KycProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "WhatsappStatusEvent_providerMessageId_status_statusTimest_key" RENAME TO "WhatsappStatusEvent_providerMessageId_status_statusTimestam_key";
