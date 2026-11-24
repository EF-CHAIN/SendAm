-- Per-corridor fee schedule (#997). Replaces the flat 1% fee with a clamped
-- formula (amount * rate + baseCost) so micro-payments always cover the fixed
-- Stellar network and off-ramp costs. Rules are managed through the admin API.
-- CreateTable
CREATE TABLE "FeeRule" (
    "id" TEXT NOT NULL,
    "sourceCurrency" TEXT NOT NULL DEFAULT '*',
    "targetCurrency" TEXT NOT NULL DEFAULT '*',
    "rateBps" INTEGER NOT NULL DEFAULT 100,
    "baseCost" TEXT NOT NULL DEFAULT '0',
    "minFee" TEXT NOT NULL,
    "maxFee" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeRule_sourceCurrency_targetCurrency_key" ON "FeeRule"("sourceCurrency", "targetCurrency");

-- CreateIndex
CREATE INDEX "FeeRule_active_priority_idx" ON "FeeRule"("active", "priority");

-- Seed the default schedule. The margin invariant (minFee > baseCost) is
-- enforced in application code and re-checked by the calculator, so these rows
-- are safe starting points operators can tune through POST/PATCH /api/admin/fee-rules.
INSERT INTO "FeeRule" ("id", "sourceCurrency", "targetCurrency", "rateBps", "baseCost", "minFee", "maxFee", "priority", "active", "version", "description", "createdAt", "updatedAt")
VALUES
    ('fee_rule_default_xlm', 'XLM', '*', 100, '0', '0.0100000', NULL, 10, true, 1, 'Default XLM outbound fee: 1% with a floor that keeps every payment margin-positive', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fee_rule_default_usdc', 'USDC', '*', 100, '0', '0.0200000', NULL, 10, true, 1, 'Default USDC outbound fee: 1% with a floor for micro-payments', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fee_rule_default_ngn', 'NGN', '*', 100, '0', '40.00', NULL, 10, true, 1, 'Default NGN off-ramp fee: 1% with a floor for micro-payments', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fee_rule_default_ghs', 'GHS', '*', 100, '0', '0.50', NULL, 10, true, 1, 'Default GHS off-ramp fee: 1% with a floor for micro-payments', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fee_rule_default_usd', 'USD', '*', 100, '0', '0.20', NULL, 10, true, 1, 'Default USD off-ramp fee: 1% with a floor for micro-payments', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('fee_rule_default_fallback', '*', '*', 100, '0', '0.20', NULL, 0, true, 1, 'Fallback fee for corridors without a specific rule', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
