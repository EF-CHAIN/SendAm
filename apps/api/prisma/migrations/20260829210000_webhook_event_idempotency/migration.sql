-- Unified callback replay protection (#311).
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "subjectId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'processing',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "skippedReason" TEXT,
    "error" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- The claim that makes a duplicate delivery a no-op.
CREATE UNIQUE INDEX "WebhookEvent_source_eventKey_key" ON "WebhookEvent"("source", "eventKey");

-- Ordering guard: newest completed event for a subject.
CREATE INDEX "WebhookEvent_source_subjectId_eventAt_idx" ON "WebhookEvent"("source", "subjectId", "eventAt");

-- Operator queries for stuck or failed callbacks.
CREATE INDEX "WebhookEvent_state_updatedAt_idx" ON "WebhookEvent"("state", "updatedAt");

-- Retention sweep (#315) purges by age.
CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");
