-- Add multi-tenant partner model for isolation and authorization scoping
CREATE TABLE "Partner" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "externalId" TEXT UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'active',
  "config" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "Partner_status_idx" ON "Partner"("status");

-- Add partner isolation field to admin users
ALTER TABLE "AdminUser" ADD COLUMN "partnerId" TEXT;
CREATE INDEX "AdminUser_partnerId_idx" ON "AdminUser"("partnerId");

ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add reconciliation checkpoint model for deterministic transaction reconciliation
CREATE TABLE "ReconciliationCheckpoint" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "transactionId" TEXT NOT NULL,
  "walletId" TEXT,
  "checkpointType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "walletBalance" TEXT,
  "ledgerBalance" TEXT,
  "databaseBalance" TEXT,
  "mismatchDetails" JSONB NOT NULL DEFAULT '{}',
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "resolvedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "ReconciliationCheckpoint_transactionId_checkpointType_idx" ON "ReconciliationCheckpoint"("transactionId", "checkpointType");
CREATE INDEX "ReconciliationCheckpoint_status_createdAt_idx" ON "ReconciliationCheckpoint"("status", "createdAt");
CREATE INDEX "ReconciliationCheckpoint_walletId_idx" ON "ReconciliationCheckpoint"("walletId");

ALTER TABLE "ReconciliationCheckpoint" ADD CONSTRAINT "ReconciliationCheckpoint_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add support case model for structured support workflow
CREATE TABLE "SupportCase" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "caseNumber" TEXT NOT NULL UNIQUE,
  "userId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "transactionId" TEXT,
  "walletId" TEXT,
  "linkedCases" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "assignedTo" TEXT,
  "resolution" TEXT,
  "resolvedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "SupportCase_userId_status_idx" ON "SupportCase"("userId", "status");
CREATE INDEX "SupportCase_status_createdAt_idx" ON "SupportCase"("status", "createdAt");
CREATE INDEX "SupportCase_priority_status_idx" ON "SupportCase"("priority", "status");
CREATE INDEX "SupportCase_assignedTo_idx" ON "SupportCase"("assignedTo");
CREATE UNIQUE INDEX "SupportCase_caseNumber_key" ON "SupportCase"("caseNumber");

ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add support case comment model for audit trail
CREATE TABLE "SupportCaseComment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "caseId" TEXT NOT NULL,
  "authorType" TEXT NOT NULL,
  "authorId" TEXT,
  "actionType" TEXT NOT NULL,
  "body" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "SupportCaseComment_caseId_createdAt_idx" ON "SupportCaseComment"("caseId", "createdAt");
CREATE INDEX "SupportCaseComment_authorType_idx" ON "SupportCaseComment"("authorType");

ALTER TABLE "SupportCaseComment" ADD CONSTRAINT "SupportCaseComment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "SupportCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add support case snapshot model for historical context
CREATE TABLE "SupportCaseSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "caseId" TEXT NOT NULL,
  "snapshotType" TEXT NOT NULL,
  "userData" JSONB NOT NULL,
  "walletData" JSONB,
  "transactionData" JSONB,
  "context" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "SupportCaseSnapshot_caseId_snapshotType_idx" ON "SupportCaseSnapshot"("caseId", "snapshotType");

ALTER TABLE "SupportCaseSnapshot" ADD CONSTRAINT "SupportCaseSnapshot_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "SupportCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
