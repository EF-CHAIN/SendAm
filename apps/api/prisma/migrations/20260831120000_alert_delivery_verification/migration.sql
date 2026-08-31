-- Migration: Continuous alert-delivery verification
-- Issue #228 — synthetic end-to-end alert-delivery tests with fallback routing,
-- delivery acknowledgement tracking, missed-test detection, and a persisted
-- last-successful-verification state.

-- ─── AlertDeliveryTest: one row per synthetic end-to-end alert test ─────────
-- `testId` is deterministic per interval epoch so duplicate scheduler
-- executions collide on the unique key and can never create an alert storm.
-- `routes` is a JSON array of per-route outcomes (primary text + optional
-- template fallback); delivery confirmation is reconciled from the linked
-- Notification's provider delivery status.
CREATE TABLE "AlertDeliveryTest" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'dispatched',
    "recipient" TEXT NOT NULL,
    "routes" JSONB NOT NULL DEFAULT '[]',
    "primaryRoute" TEXT NOT NULL DEFAULT 'whatsapp-text',
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "providerMessageId" TEXT,
    "syncOutcome" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "timeoutAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertDeliveryTest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AlertDeliveryTest_testId_key" ON "AlertDeliveryTest"("testId");
CREATE INDEX "AlertDeliveryTest_status_idx" ON "AlertDeliveryTest"("status");
CREATE INDEX "AlertDeliveryTest_attemptedAt_idx" ON "AlertDeliveryTest"("attemptedAt");

-- ─── AlertDeliveryState: singleton operational status ───────────────────────
-- Holds the current health (healthy|degraded|failed|unknown|disabled) and the
-- last successful end-to-end verification timestamp. A failed test updates
-- failure fields but never clears lastSuccessfulTestAt.
CREATE TABLE "AlertDeliveryState" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "overallStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastSuccessfulTestAt" TIMESTAMP(3),
    "lastTestId" TEXT,
    "lastDispatchAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureReason" TEXT,
    "lastFailureDetail" JSONB NOT NULL DEFAULT '{}',
    "routesDiagnostics" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertDeliveryState_pkey" PRIMARY KEY ("id")
);