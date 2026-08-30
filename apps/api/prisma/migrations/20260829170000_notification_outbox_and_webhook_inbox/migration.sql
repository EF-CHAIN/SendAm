-- Durable outbound intent (#286) and durable inbound callbacks (#287).

-- ── #286: outbox fields on Notification ────────────────────────────────────
-- The Notification row is now written *before* the provider is called, so a
-- crash after Meta accepts a message but before we record it still leaves a
-- durable record to reconcile against.
ALTER TABLE "Notification"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "sendAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

-- A stable key per logical send: a retry re-uses the existing row rather than
-- creating a second one and sending the message twice.
CREATE UNIQUE INDEX "Notification_idempotencyKey_key"
  ON "Notification"("idempotencyKey");

-- Supports the reconciliation sweep over sends stuck mid-flight.
CREATE INDEX "Notification_status_claimedAt_idx"
  ON "Notification"("status", "claimedAt");

-- ── #287: durable webhook inbox ────────────────────────────────────────────
CREATE TABLE "WebhookInboxEvent" (
  "id"            TEXT NOT NULL,
  "provider"      TEXT NOT NULL DEFAULT 'meta',
  "eventType"     TEXT NOT NULL,
  "eventKey"      TEXT NOT NULL,
  "payload"       JSONB NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'pending',
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "lastError"     TEXT,
  "claimedAt"     TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"   TIMESTAMP(3),
  "receivedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WebhookInboxEvent_pkey" PRIMARY KEY ("id")
);

-- Idempotency: a provider redelivering the same batch item is a no-op.
CREATE UNIQUE INDEX "WebhookInboxEvent_provider_eventKey_key"
  ON "WebhookInboxEvent"("provider", "eventKey");

-- Drain order and backlog/age metrics.
CREATE INDEX "WebhookInboxEvent_status_nextAttemptAt_idx"
  ON "WebhookInboxEvent"("status", "nextAttemptAt");
CREATE INDEX "WebhookInboxEvent_status_receivedAt_idx"
  ON "WebhookInboxEvent"("status", "receivedAt");
