-- Atomic quote/payment transaction (issue: orphan quotes on rollback) + quote
-- lifecycle state, idempotency keys, and requote chain.
ALTER TABLE "Quote" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "Quote" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Quote" ADD COLUMN "replacedById" TEXT;

CREATE INDEX "Quote_status_idx" ON "Quote"("status");
CREATE UNIQUE INDEX "Quote_idempotencyKey_key" ON "Quote"("idempotencyKey");

-- Self-relation: a quote can supersede an earlier one (requote).
ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_replacedById_fkey"
  FOREIGN KEY ("replacedById") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Payment reservation idempotency: retrying a request reuses the same row
-- instead of creating duplicate active transactions.
ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Transaction_idempotencyKey_key" ON "Transaction"("idempotencyKey");
