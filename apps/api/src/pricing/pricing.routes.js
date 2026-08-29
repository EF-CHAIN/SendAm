const express = require('express');
const router = express.Router();
const { createQuote, reconcileQuotes, QUOTE_STATUS } = require('./pricing.service');
const { sendSuccess, sendError } = require('../utils/response');
const requireRestSession = require('../middlewares/requireRestSession');
const config = require('../config/env');

// Allowlist of server-controlled provider/route values
const ALLOWED_PROVIDERS = new Set(['stellar', 'exchangerate-api']);
const ALLOWED_ROUTES = new Set(['stellar']);

// Rate limit configuration for quote creation (per identity + IP)
const quoteRateLimitStore = new Map();
const QUOTE_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const QUOTE_RATE_LIMIT_MAX = 30; // 30 quotes per minute per identity

const quoteRateLimitKey = (identity, ip) => `quote:${identity}:${ip}`;

const checkQuoteRateLimit = (identity, ip) => {
  const key = quoteRateLimitKey(identity, ip);
  const now = Date.now();
  const entry = quoteRateLimitStore.get(key);
  
  if (!entry || now - entry.windowStart > QUOTE_RATE_LIMIT_WINDOW_MS) {
    quoteRateLimitStore.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: QUOTE_RATE_LIMIT_MAX - 1 };
  }
  
  if (entry.count >= QUOTE_RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, retryAfterMs: QUOTE_RATE_LIMIT_WINDOW_MS - (now - entry.windowStart) };
  }
  
  entry.count += 1;
  return { allowed: true, remaining: QUOTE_RATE_LIMIT_MAX - entry.count };
};

// Periodic cleanup of abandoned preview quotes (runs on each request, low overhead)
const cleanupAbandonedPreviews = async () => {
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes
    const { prisma } = require('../common/prisma');
    
    // Find active quotes that have no transaction and are older than 5 minutes
    const abandoned = await prisma.quote.findMany({
      where: {
        status: QUOTE_STATUS.ACTIVE,
        createdAt: { lt: cutoff },
        transactions: { none: {} },
      },
      select: { id: true },
    });
    
    if (abandoned.length > 0) {
      await prisma.quote.updateMany({
        where: { id: { in: abandoned.map((q) => q.id) } },
        data: { status: QUOTE_STATUS.ORPHANED },
      });
    }
  } catch (_error) {
    // Non-blocking cleanup; log and continue
    const logger = require('../utils/logger');
    logger.warn('quote_preview_cleanup_failed', { message: _error?.message || String(_error) });
  }
};

router.post('/quote', requireRestSession, async (req, res, next) => {
  try {
    // Derive userId from authenticated session — never trust caller input
    const userId = req.restUser.id;
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    
    // Rate limit by identity + IP
    const rateLimit = checkQuoteRateLimit(userId, clientIp);
    if (!rateLimit.allowed) {
      return sendError(res, 'Too many quote requests. Please wait before trying again.', 429, {
        retryAfter: Math.ceil(rateLimit.retryAfterMs / 1000),
      });
    }
    
    // Extract and validate allowed fields from request body
    const {
      sourceCurrency = 'NGN',
      targetCurrency = 'USDC',
      sourceAmount,
      route = 'stellar',
      provider = 'stellar',
      idempotencyKey,
    } = req.body || {};
    
    // Validate required fields
    if (!sourceAmount) {
      return sendError(res, 'sourceAmount is required', 400);
    }
    
    // Allowlist server-controlled provider/route values
    if (!ALLOWED_ROUTES.has(route)) {
      return sendError(res, `Invalid route. Allowed: ${Array.from(ALLOWED_ROUTES).join(', ')}`, 400);
    }
    if (!ALLOWED_PROVIDERS.has(provider)) {
      return sendError(res, `Invalid provider. Allowed: ${Array.from(ALLOWED_PROVIDERS).join(', ')}`, 400);
    }
    
    // Create quote with server-derived userId and validated fields
    const quote = await createQuote({
      userId,
      sourceCurrency,
      targetCurrency,
      sourceAmount,
      route,
      provider,
      idempotencyKey,
    });
    
    // Non-blocking cleanup of abandoned preview quotes
    cleanupAbandonedPreviews().catch(() => {});
    
    return sendSuccess(res, quote, 'Quote generated');
  } catch (error) {
    next(error);
  }
});

// Optional: periodic reconciliation endpoint (protected, admin-only in production)
router.post('/reconcile', requireRestSession, async (req, res, next) => {
  try {
    // In production, restrict to admin users
    if (config.isProduction && req.restUser?.role !== 'admin') {
      return sendError(res, 'Forbidden', 403);
    }
    
    const result = await reconcileQuotes({ emit: true });
    return sendSuccess(res, result, 'Quote reconciliation complete');
  } catch (error) {
    next(error);
  }
});

module.exports = router;
