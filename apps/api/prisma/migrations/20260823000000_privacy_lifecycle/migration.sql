-- Customer privacy lifecycle: erasure/export requests, legal holds, and
-- provider propagation tasks. `User.anonymizedAt` marks an anonymized account
-- so erasure is idempotent and ledger/audit rows stay intact.

ALTER TABLE "User" ADD COLUMN "anonymizedAt" TIMESTAMP(3);
CREATE INDEX "User_anonymizedAt_idx" ON "User"("anonymizedAt");

CREATE TABLE "PrivacyRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "requestedBy" TEXT,
  "approvedBy" TEXT,
  "approvedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrivacyRequest_userId_status_idx" ON "PrivacyRequest"("userId", "status");
CREATE INDEX "PrivacyRequest_status_idx" ON "PrivacyRequest"("status");
CREATE INDEX "PrivacyRequest_type_idx" ON "PrivacyRequest"("type");
ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LegalHold" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "heldBy" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "LegalHold_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LegalHold_userId_idx" ON "LegalHold"("userId");
CREATE INDEX "LegalHold_expiresAt_idx" ON "LegalHold"("expiresAt");
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PrivacyProviderTask" (
  "id" TEXT NOT NULL,
  "privacyRequestId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrivacyProviderTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrivacyProviderTask_privacyRequestId_status_idx" ON "PrivacyProviderTask"("privacyRequestId", "status");
CREATE INDEX "PrivacyProviderTask_provider_idx" ON "PrivacyProviderTask"("provider");
ALTER TABLE "PrivacyProviderTask" ADD CONSTRAINT "PrivacyProviderTask_privacyRequestId_fkey"
  FOREIGN KEY ("privacyRequestId") REFERENCES "PrivacyRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
