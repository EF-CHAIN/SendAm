-- Per-category messaging consent (#310).
CREATE TABLE "MessagingConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'customer_request',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingConsentRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessagingConsentRecord_userId_category_key" ON "MessagingConsentRecord"("userId", "category");
CREATE INDEX "MessagingConsentRecord_userId_idx" ON "MessagingConsentRecord"("userId");
CREATE INDEX "MessagingConsentRecord_category_status_idx" ON "MessagingConsentRecord"("category", "status");

ALTER TABLE "MessagingConsentRecord"
    ADD CONSTRAINT "MessagingConsentRecord_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry existing blanket opt-outs across. A customer who sent STOP before this
-- change did not consent to start receiving marketing again because the schema
-- grew, so every optional category is written as denied for them.
INSERT INTO "MessagingConsentRecord" ("id", "userId", "category", "status", "source", "createdAt", "updatedAt")
SELECT
    md5(random()::text || u."id" || c.category),
    u."id",
    c.category,
    'denied',
    COALESCE(u."consentSource", 'system'),
    COALESCE(u."consentUpdatedAt", NOW()),
    NOW()
FROM "User" u
CROSS JOIN (VALUES ('service'), ('product'), ('marketing')) AS c(category)
WHERE u."messagingConsent" = 'opted_out'
ON CONFLICT DO NOTHING;
