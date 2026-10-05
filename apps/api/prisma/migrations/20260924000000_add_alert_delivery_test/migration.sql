-- Migration: add_alert_delivery_test (issue #228)
-- Adds a durable record of each synthetic alert-delivery test so operators
-- can see when alert routing was last verified end-to-end, and so the worker
-- can detect a missed/overdue test even after a restart.

CREATE TABLE "AlertDeliveryTest" (
    "id"            TEXT        NOT NULL,
    "testId"        TEXT        NOT NULL,
    "overallResult" TEXT        NOT NULL,
    "startedAt"     TIMESTAMP(3) NOT NULL,
    "completedAt"   TIMESTAMP(3) NOT NULL,
    "durationMs"    INTEGER     NOT NULL,
    "routes"        JSONB       NOT NULL DEFAULT '[]',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertDeliveryTest_pkey" PRIMARY KEY ("id")
);

-- Unique test run identity
CREATE UNIQUE INDEX "AlertDeliveryTest_testId_key" ON "AlertDeliveryTest"("testId");

-- Fast lookups for most-recent test and most-recent successful test
CREATE INDEX "AlertDeliveryTest_completedAt_idx" ON "AlertDeliveryTest"("completedAt");
CREATE INDEX "AlertDeliveryTest_overallResult_completedAt_idx" ON "AlertDeliveryTest"("overallResult", "completedAt");
