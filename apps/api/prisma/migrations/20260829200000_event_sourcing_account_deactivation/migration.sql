-- Migration: Event sourcing and account deactivation
-- Issues #318 (WorkflowEvent ledger) and #332 (AccountStatusRecord, User deactivation fields)

-- ─── WorkflowEvent: immutable, chained event log ────────────────────────────
CREATE TABLE "WorkflowEvent" (
    "id"            TEXT NOT NULL,
    "eventType"     TEXT NOT NULL,
    "aggregateType" TEXT,
    "aggregateId"   TEXT,
    "actorType"     TEXT NOT NULL DEFAULT 'system',
    "actorId"       TEXT,
    "payload"       JSONB NOT NULL DEFAULT '{}',
    "previousHash"  TEXT,
    "hash"          TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowEvent_previousHash_key" ON "WorkflowEvent"("previousHash");
CREATE UNIQUE INDEX "WorkflowEvent_hash_key" ON "WorkflowEvent"("hash");
CREATE INDEX "WorkflowEvent_eventType_createdAt_idx" ON "WorkflowEvent"("eventType", "createdAt");
CREATE INDEX "WorkflowEvent_aggregateType_aggregateId_idx" ON "WorkflowEvent"("aggregateType", "aggregateId");
CREATE INDEX "WorkflowEvent_actorType_actorId_idx" ON "WorkflowEvent"("actorType", "actorId");
CREATE INDEX "WorkflowEvent_createdAt_id_idx" ON "WorkflowEvent"("createdAt", "id");

-- ─── AccountStatusRecord: deactivation / reactivation history ───────────────
CREATE TABLE "AccountStatusRecord" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "status"      TEXT NOT NULL,
    "reason"      TEXT NOT NULL,
    "notes"       TEXT,
    "initiatedBy" TEXT NOT NULL,
    "approvedBy"  TEXT,
    "approvedAt"  TIMESTAMP(3),
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountStatusRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountStatusRecord_userId_createdAt_idx" ON "AccountStatusRecord"("userId", "createdAt");
CREATE INDEX "AccountStatusRecord_status_createdAt_idx" ON "AccountStatusRecord"("status", "createdAt");

ALTER TABLE "AccountStatusRecord" ADD CONSTRAINT "AccountStatusRecord_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── User: deactivation fields ───────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deactivatedAt"      TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deactivationReason" TEXT;

CREATE INDEX IF NOT EXISTS "User_deactivatedAt_idx" ON "User"("deactivatedAt");
