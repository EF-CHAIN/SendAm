'use strict';

// Persistence, caching and admin lifecycle for per-corridor fee rules (#997).
//
// Fee rules live in the `FeeRule` table so operators can retune pricing from
// the admin API (`/api/admin/fee-rules`) without a redeploy. Quotes read the
// active rule set through a short-lived in-process cache to keep pricing off
// the database hot path; every mutation invalidates that cache immediately.
// When the table is unavailable (fresh install, unit tests without a database)
// the calculator falls back to its built-in default schedule instead of
// failing the quote.

const config = require('../config/env');
const logger = require('../utils/logger');
const { withIdAlias, withIdAliases } = require('../common/records');
const {
  DEFAULT_FEE_RULES,
  FEE_RULE_ERROR_CODES,
  FeeRuleError,
  corridorKey,
  normalizeCurrency,
  normalizeFeeRule,
  priceWithRules,
  resolveFeeRule,
} = require('./feeCalculator');

let cache = { rules: null, loadedAt: 0 };

const defaultPrisma = () => require('../common/prisma');

const cacheTtlMs = () => {
  const configured = Number(config.pricing?.feeRuleCacheTtlMs);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30000;
};

const writeAuditLog = async (args) => {
  try {
    return await require('../common/audit.service').writeAuditLog(args);
  } catch (_error) {
    return null;
  }
};

/** Drop the cached rule set; called after every admin mutation. */
const resetFeeRuleCache = () => {
  cache = { rules: null, loadedAt: 0 };
};

const serializeRule = (rule) => ({
  ...rule,
  corridor: corridorKey(rule.sourceCurrency, rule.targetCurrency),
});

const toModelInput = (rule) => ({
  sourceCurrency: rule.sourceCurrency,
  targetCurrency: rule.targetCurrency,
  rateBps: rule.rateBps,
  baseCost: rule.baseCost,
  minFee: rule.minFee,
  maxFee: rule.maxFee,
  priority: rule.priority,
  active: rule.active,
  description: rule.description ?? undefined,
});

/**
 * Load the active rule set, using the cache while it is fresh. A database
 * failure degrades to the last known-good set (or the built-in defaults) rather
 * than blocking quotes.
 */
const loadActiveRules = async ({ db, force = false } = {}) => {
  const fresh = cache.rules && Date.now() - cache.loadedAt <= cacheTtlMs();
  if (fresh && !force) return cache.rules;

  const client = db || defaultPrisma();
  if (!client?.feeRule?.findMany) return cache.rules || [];

  try {
    const rows = await client.feeRule.findMany({
      where: { active: true },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
    const rules = withIdAliases(rows.map(serializeRule));
    cache = { rules, loadedAt: Date.now() };
    return rules;
  } catch (error) {
    logger.warn('fee_rule_lookup_failed', { message: error?.message || String(error) });
    return cache.rules || [];
  }
};

/**
 * Resolve the fee rule for a corridor, falling back to the built-in schedule
 * when the database has no matching row.
 */
const getFeeRuleForQuote = async ({ db, asset, sourceCurrency, targetCurrency } = {}) => {
  const source = normalizeCurrency(sourceCurrency || asset);
  const target = normalizeCurrency(targetCurrency || source);
  const rules = await loadActiveRules({ db });
  const rule = resolveFeeRule({ rules, asset, sourceCurrency: source, targetCurrency: target });
  if (rule) return rule;
  return resolveFeeRule({ rules: DEFAULT_FEE_RULES, asset, sourceCurrency: source, targetCurrency: target });
};

/**
 * Price a quote. Returns the calculator breakdown (fee, clamp state, margin)
 * plus the matched rule, ready to stamp onto a Quote.
 */
const calculateQuoteFee = async ({
  db,
  asset,
  amount,
  sourceCurrency,
  targetCurrency,
} = {}) => {
  const source = normalizeCurrency(sourceCurrency || asset);
  const target = normalizeCurrency(targetCurrency || source);
  const rules = await loadActiveRules({ db });
  return priceWithRules({
    amount,
    asset,
    sourceCurrency: source,
    targetCurrency: target,
    // An empty set means the table is unavailable or unseeded: price from the
    // built-in schedule rather than the bare wildcard fallback.
    rules: rules.length ? rules : DEFAULT_FEE_RULES,
  });
};

const listFeeRules = async ({ db, includeInactive = false } = {}) => {
  const client = db || defaultPrisma();
  const rows = await client.feeRule.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ sourceCurrency: 'asc' }, { targetCurrency: 'asc' }, { priority: 'desc' }],
  });
  return withIdAliases(rows.map(serializeRule));
};

const getFeeRuleById = async ({ db, id } = {}) => {
  const client = db || defaultPrisma();
  const row = await client.feeRule.findUnique({ where: { id } });
  return row ? withIdAlias(serializeRule(row)) : null;
};

const createFeeRule = async ({ db, input = {}, actorId = null } = {}) => {
  const client = db || defaultPrisma();
  const normalized = normalizeFeeRule({ ...input, source: 'database' });

  const existing = await client.feeRule.findUnique({
    where: {
      sourceCurrency_targetCurrency: {
        sourceCurrency: normalized.sourceCurrency,
        targetCurrency: normalized.targetCurrency,
      },
    },
  });
  if (existing) {
    throw new FeeRuleError(
      FEE_RULE_ERROR_CODES.INVALID_RULE,
      `A fee rule already exists for ${corridorKey(normalized.sourceCurrency, normalized.targetCurrency)}. Update it instead.`,
    );
  }

  const created = await client.feeRule.create({
    data: { ...toModelInput(normalized), version: 1, createdBy: actorId, updatedBy: actorId },
  });
  resetFeeRuleCache();

  await writeAuditLog({
    actorType: actorId ? 'administrator' : 'system',
    actorId: actorId || undefined,
    action: 'feeRule.created',
    entityType: 'FeeRule',
    entityId: String(created.id),
    metadata: serializeRule(created),
  });

  return withIdAlias(serializeRule(created));
};

const updateFeeRule = async ({ db, id, input = {}, actorId = null } = {}) => {
  const client = db || defaultPrisma();
  const existing = await client.feeRule.findUnique({ where: { id } });
  if (!existing) return null;

  // Merge onto the stored row so partial PATCHes still re-validate the full
  // rule (including the minFee > baseCost margin invariant).
  const merged = normalizeFeeRule({
    ...existing,
    ...input,
    source: 'database',
    version: Number(existing.version || 1),
  });

  const updated = await client.feeRule.update({
    where: { id },
    data: { ...toModelInput(merged), version: Number(existing.version || 1) + 1, updatedBy: actorId },
  });
  resetFeeRuleCache();

  await writeAuditLog({
    actorType: actorId ? 'administrator' : 'system',
    actorId: actorId || undefined,
    action: 'feeRule.updated',
    entityType: 'FeeRule',
    entityId: String(updated.id),
    metadata: { before: serializeRule(existing), after: serializeRule(updated) },
  });

  return withIdAlias(serializeRule(updated));
};

const deleteFeeRule = async ({ db, id, actorId = null } = {}) => {
  const client = db || defaultPrisma();
  const existing = await client.feeRule.findUnique({ where: { id } });
  if (!existing) return null;

  await client.feeRule.delete({ where: { id } });
  resetFeeRuleCache();

  await writeAuditLog({
    actorType: actorId ? 'administrator' : 'system',
    actorId: actorId || undefined,
    action: 'feeRule.deleted',
    entityType: 'FeeRule',
    entityId: String(id),
    metadata: serializeRule(existing),
  });

  return withIdAlias(serializeRule(existing));
};

/** Dry-run price for an amount against the currently active rules. */
const previewFee = async ({ db, amount, asset, sourceCurrency, targetCurrency } = {}) => (
  calculateQuoteFee({ db, amount, asset, sourceCurrency, targetCurrency })
);

module.exports = {
  DEFAULT_FEE_RULES,
  resetFeeRuleCache,
  loadActiveRules,
  getFeeRuleForQuote,
  calculateQuoteFee,
  listFeeRules,
  getFeeRuleById,
  createFeeRule,
  updateFeeRule,
  deleteFeeRule,
  previewFee,
};
