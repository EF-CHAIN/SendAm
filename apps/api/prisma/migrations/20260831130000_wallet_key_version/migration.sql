-- Add versioned KMS key metadata to Wallet (schema drift fix).
-- The schema declares keyVersion (default 'v1') for the versioned-key crypto
-- rotation feature, but no migration ever added the column, so fresh
-- `prisma migrate deploy` databases are out of sync with the schema and the
-- seed script (which upserts keyVersion) fails. Existing rows default to v1.
ALTER TABLE "Wallet"
  ADD COLUMN "keyVersion" TEXT DEFAULT 'v1';
