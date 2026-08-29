-- Existing rows predate durable enqueue tracking and already represent
-- accepted/processed messages, so they safely backfill as completed.
ALTER TABLE "ProcessedMessage"
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed',
ADD COLUMN "lastError" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "ProcessedMessage_status_updatedAt_idx"
ON "ProcessedMessage"("status", "updatedAt");
