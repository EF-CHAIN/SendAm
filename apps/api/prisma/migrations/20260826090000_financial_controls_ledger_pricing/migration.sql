-- Quote audit provenance.
ALTER TABLE "Quote" ADD COLUMN "sourceTimestamp" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN "spread" TEXT NOT NULL DEFAULT '0';
ALTER TABLE "Quote" ADD COLUMN "feePolicyVersion" TEXT NOT NULL DEFAULT 'standard-v1';
ALTER TABLE "Quote" ADD COLUMN "providerResponse" JSONB;

-- Append-only internal ledger.
CREATE TABLE "LedgerAccount" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "asset" TEXT NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JournalEntry" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "transactionId" TEXT,
  "externalRef" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LedgerPosting" (
  "id" TEXT NOT NULL,
  "journalEntryId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "asset" TEXT NOT NULL,
  "amount" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerPosting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LedgerAccount_key_key" ON "LedgerAccount"("key");
CREATE INDEX "LedgerAccount_type_asset_idx" ON "LedgerAccount"("type", "asset");
CREATE INDEX "LedgerAccount_userId_idx" ON "LedgerAccount"("userId");
CREATE INDEX "JournalEntry_eventType_createdAt_idx" ON "JournalEntry"("eventType", "createdAt");
CREATE INDEX "JournalEntry_transactionId_idx" ON "JournalEntry"("transactionId");
CREATE INDEX "JournalEntry_externalRef_idx" ON "JournalEntry"("externalRef");
CREATE INDEX "LedgerPosting_journalEntryId_idx" ON "LedgerPosting"("journalEntryId");
CREATE INDEX "LedgerPosting_accountId_idx" ON "LedgerPosting"("accountId");
CREATE INDEX "LedgerPosting_asset_createdAt_idx" ON "LedgerPosting"("asset", "createdAt");

ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LedgerPosting" ADD CONSTRAINT "LedgerPosting_journalEntryId_fkey"
  FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LedgerPosting" ADD CONSTRAINT "LedgerPosting_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger records are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerAccount_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerAccount"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER "JournalEntry_append_only"
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER "LedgerPosting_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerPosting"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
