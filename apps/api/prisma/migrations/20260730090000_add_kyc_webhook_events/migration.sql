CREATE TABLE "KycWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "profileId" TEXT,
  "resultCode" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KycWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KycWebhookEvent_provider_providerEventId_key"
ON "KycWebhookEvent"("provider", "providerEventId");

CREATE INDEX "KycWebhookEvent_profileId_idx" ON "KycWebhookEvent"("profileId");
CREATE INDEX "KycWebhookEvent_receivedAt_idx" ON "KycWebhookEvent"("receivedAt");
