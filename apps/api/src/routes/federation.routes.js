const express = require('express');
const prisma = require('../common/prisma');
const { canonicalizePhoneNumber } = require('../utils/validators');
const stellarAdapter = require('../wallet/stellar.adapter');

const DEFAULT_FEDERATION_DOMAIN = (process.env.FEDERATION_DOMAIN || 'sendam.io').trim().toLowerCase();

/**
 * Parses a SEP-2 federation address of the form `<name>*<domain>`.
 *
 * @param {string} query
 * @returns {{ name: string, domain: string } | null}
 */
const parseFederationAddress = (query) => {
  if (typeof query !== 'string') return null;
  const trimmed = query.trim();
  const parts = trimmed.split('*');
  if (parts.length !== 2) return null;
  const [name, domain] = parts.map((p) => p.trim());
  if (!name || !domain) return null;
  return { name, domain: domain.toLowerCase() };
};

/**
 * Builds the SEP-2 federation router with injectable dependencies for testing.
 *
 * @param {object} [deps]
 * @param {object} [deps.prismaClient]
 * @param {string} [deps.domain]
 * @param {Function} [deps.resolveMemo] - Optional (user, wallet) => { memo, memo_type } | null
 * @returns {import('express').Router}
 */
const createFederationRouter = ({
  prismaClient = prisma,
  domain = DEFAULT_FEDERATION_DOMAIN,
  resolveMemo = null,
} = {}) => {
  const router = express.Router();
  const expectedDomain = String(domain || DEFAULT_FEDERATION_DOMAIN).trim().toLowerCase();

  // SEP-2 requires CORS "*" so external Stellar wallets can query federation endpoints.
  router.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  router.get('/', async (req, res, next) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const type = typeof req.query.type === 'string' ? req.query.type.trim().toLowerCase() : '';

      if (!q || !type) {
        return res.status(400).json({ detail: 'Missing required query parameters: q and type' });
      }

      if (type === 'name') {
        const parsed = parseFederationAddress(q);
        if (!parsed) {
          return res.status(400).json({ detail: 'Invalid federation address format; expected name*domain' });
        }

        if (parsed.domain !== expectedDomain) {
          return res.status(404).json({ detail: 'Federation domain not found' });
        }

        let canonicalPhone;
        try {
          canonicalPhone = canonicalizePhoneNumber(parsed.name);
        } catch (_err) {
          return res.status(404).json({ detail: 'User not found' });
        }

        const user = await prismaClient.user.findUnique({
          where: { phoneNumber: canonicalPhone },
          include: {
            wallets: {
              where: { chain: 'stellar' },
            },
          },
        });

        if (!user || user.deletedAt || user.deactivatedAt) {
          return res.status(404).json({ detail: 'User not found' });
        }

        const stellarWallet = Array.isArray(user.wallets)
          ? user.wallets.find((w) => w && w.publicKey)
          : null;

        if (!stellarWallet || !stellarWallet.publicKey) {
          return res.status(404).json({ detail: 'Stellar account not found for user' });
        }

        const payload = {
          stellar_address: `${canonicalPhone}*${expectedDomain}`,
          account_id: stellarWallet.publicKey,
        };

        const memoInfo = typeof resolveMemo === 'function'
          ? resolveMemo(user, stellarWallet)
          : (stellarWallet.memo
            ? { memo: String(stellarWallet.memo), memo_type: stellarWallet.memoType || 'text' }
            : null);

        if (memoInfo && memoInfo.memo !== undefined && memoInfo.memo !== null && memoInfo.memo !== '') {
          payload.memo_type = memoInfo.memo_type || 'text';
          payload.memo = String(memoInfo.memo);
        }

        return res.status(200).json(payload);
      }

      if (type === 'id') {
        if (!stellarAdapter.validateAddress(q)) {
          return res.status(400).json({ detail: 'Invalid Stellar account_id' });
        }

        const wallet = await prismaClient.wallet.findFirst({
          where: { chain: 'stellar', publicKey: q },
          include: { user: true },
        });

        if (!wallet || !wallet.user || wallet.user.deletedAt || wallet.user.deactivatedAt) {
          return res.status(404).json({ detail: 'Account not found' });
        }

        return res.status(200).json({
          stellar_address: `${wallet.user.phoneNumber}*${expectedDomain}`,
          account_id: wallet.publicKey,
        });
      }

      return res.status(400).json({ detail: `Unsupported federation lookup type: ${type}` });
    } catch (err) {
      return next(err);
    }
  });

  return router;
};

const defaultRouter = createFederationRouter();
defaultRouter.createFederationRouter = createFederationRouter;
defaultRouter.parseFederationAddress = parseFederationAddress;

module.exports = defaultRouter;
