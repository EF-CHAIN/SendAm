-- Canonical Stellar asset identity: network + native/code/issuer (#285).
--
-- Deposit and balance presentation previously reduced an issued asset to its
-- code alone (e.g. "USDC"), which anyone can issue under any issuer. This
-- persists issuer provenance so a deposit or transaction record can always be
-- traced to the exact (network, code, issuer) it moved, not just a code that
-- may or may not have come from the issuer this service trusts.

-- DepositOutboxRecord: issuer/network/trust of the asset actually observed on
-- the inbound Horizon payment operation.
ALTER TABLE "DepositOutboxRecord"
  ADD COLUMN "assetIssuer" TEXT,
  ADD COLUMN "network" TEXT,
  ADD COLUMN "trusted" BOOLEAN NOT NULL DEFAULT true;

-- Historical rows predate issuer capture entirely, so there is no on-chain
-- evidence left to backfill `assetIssuer`/`network` from. They are left NULL
-- and `trusted` defaults to true (their prior, code-only handling implicitly
-- assumed trust) rather than implying a false negative for deposits that were
-- never actually checked against an issuer.

-- Transaction: the issuer this service resolved the outbound asset to at
-- execution time (null for native XLM).
ALTER TABLE "Transaction"
  ADD COLUMN "assetIssuer" TEXT;
