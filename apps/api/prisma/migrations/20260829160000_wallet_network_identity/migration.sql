-- Make network part of wallet identity (#283).
--
-- Before this change wallet uniqueness was (userId, chain) and `network` was a
-- non-key column defaulting to 'testnet' that wallet creation never wrote.
-- Switching a deployment from testnet to mainnet therefore reused or created
-- incorrectly tagged wallet material, while authentication — which does filter
-- by network — could no longer find it.

-- 1. Record how each row's network value came to be.
--
-- Every row that exists at this point inherited the column default rather than
-- being told which network it belongs to. The database cannot distinguish a
-- wallet that genuinely is testnet from one mis-tagged during an environment
-- switch, so all pre-existing rows are marked 'assumed' rather than being
-- trusted. Application code refuses 'assumed' wallets for mainnet operations.
ALTER TABLE "Wallet"
  ADD COLUMN "networkProvenance" TEXT NOT NULL DEFAULT 'verified';

UPDATE "Wallet" SET "networkProvenance" = 'assumed';

-- Backfill any row whose network was never populated at all.
UPDATE "Wallet"
SET "network" = 'testnet'
WHERE "network" IS NULL OR btrim("network") = '';

-- Normalise historical spellings onto the canonical ids used by the network
-- profiles (#284), so the new unique constraint cannot be defeated by a row
-- recorded as 'mainnet' sitting beside one recorded as 'public'.
UPDATE "Wallet" SET "network" = 'public'  WHERE lower(btrim("network")) IN ('public', 'pubnet', 'mainnet');
UPDATE "Wallet" SET "network" = 'testnet' WHERE lower(btrim("network")) IN ('testnet', 'test', 'test-network');

-- 2. Quarantine anything still not on a supported network. These rows are kept
-- (never silently deleted) but are excluded from the identity constraint and
-- refused by the application until an operator resolves them.
UPDATE "Wallet"
SET "networkProvenance" = 'quarantined'
WHERE "network" NOT IN ('testnet', 'public');

-- 3. Replace the old identity with the network-aware one.
--
-- If two rows for the same (userId, chain) somehow carry the same network,
-- this index creation will fail loudly rather than silently dropping one —
-- which is the correct outcome for wallet material.
DROP INDEX IF EXISTS "Wallet_userId_chain_key";

CREATE UNIQUE INDEX "Wallet_userId_chain_network_key"
  ON "Wallet"("userId", "chain", "network");

CREATE INDEX "Wallet_network_chain_idx" ON "Wallet"("network", "chain");
