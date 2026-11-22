-- Scheduled and recurring WhatsApp payment mandates (#1005).
CREATE TABLE "RecurringPayment" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "userId"            TEXT NOT NULL,
  "reference"         TEXT NOT NULL,
  "destination"       TEXT NOT NULL,
  "recipientLabel"    TEXT,
  "amount"            TEXT NOT NULL,
  "asset"             TEXT NOT NULL DEFAULT 'XLM',
  "memo"              TEXT,
  "memoType"          TEXT,
  "frequency"         TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'awaiting_pin',
  "nextRunAt"         TIMESTAMP(3) NOT NULL,
  "anchorDay"         INTEGER NOT NULL DEFAULT 1,
  "reminderSentFor"   TIMESTAMP(3),
  "lastRunAt"         TIMESTAMP(3),
  "lastTransactionId" TEXT,
  "failureCount"      INTEGER NOT NULL DEFAULT 0,
  "pinConfirmedAt"    TIMESTAMP(3),
  "expiresAt"         TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecurringPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RecurringPayment_userId_reference_key" ON "RecurringPayment"("userId", "reference");
CREATE INDEX "RecurringPayment_status_nextRunAt_idx" ON "RecurringPayment"("status", "nextRunAt");
CREATE INDEX "RecurringPayment_userId_status_idx" ON "RecurringPayment"("userId", "status");
