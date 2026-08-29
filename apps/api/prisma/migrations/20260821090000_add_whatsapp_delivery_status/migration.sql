-- Existing Notification rows predate delivery-lifecycle tracking; they keep
-- their current status/timestamps and simply gain the new nullable columns.
ALTER TABLE "Notification"
ADD COLUMN "referenceType" TEXT,
ADD COLUMN "referenceId" TEXT,
ADD COLUMN "sentAt" TIMESTAMP(3),
ADD COLUMN "deliveredAt" TIMESTAMP(3),
ADD COLUMN "readAt" TIMESTAMP(3),
ADD COLUMN "failedAt" TIMESTAMP(3),
ADD COLUMN "lastStatusAt" TIMESTAMP(3),
ADD COLUMN "failureCode" TEXT,
ADD COLUMN "failureMessage" TEXT,
ADD COLUMN "retryable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Notification_providerMessageId_idx" ON "Notification"("providerMessageId");
CREATE INDEX "Notification_referenceType_referenceId_idx"
ON "Notification"("referenceType", "referenceId");

-- Durable, append-only audit trail of Meta status callbacks. The unique key
-- makes exact-duplicate redeliveries a no-op (Prisma P2002), the same
-- idempotency pattern KycWebhookEvent and ProcessedMessage already use.
CREATE TABLE "WhatsappStatusEvent" (
  "id" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "statusTimestamp" TIMESTAMP(3) NOT NULL,
  "recipientId" TEXT,
  "errorCode" TEXT,
  "errorTitle" TEXT,
  "errorMessage" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsappStatusEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsappStatusEvent_providerMessageId_status_statusTimest_key"
ON "WhatsappStatusEvent"("providerMessageId", "status", "statusTimestamp");

CREATE INDEX "WhatsappStatusEvent_providerMessageId_idx" ON "WhatsappStatusEvent"("providerMessageId");
CREATE INDEX "WhatsappStatusEvent_receivedAt_idx" ON "WhatsappStatusEvent"("receivedAt");
