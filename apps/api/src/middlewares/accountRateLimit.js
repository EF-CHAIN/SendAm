const rateLimit = require('express-rate-limit');
const PostgresRateStore = require('./postgresRateStore');
const { AppError } = require('../errors');
const { increment } = require('../observability/metrics');

// Keys by the authenticated account (set by requireRestSession) so one
// account cannot dodge the limit by rotating IPs. Requests that somehow reach
// this middleware unauthenticated fall back to IP so they are still bounded.
const accountOrIpKey = (req) => (req.restUser && req.restUser.id ? `account:${req.restUser.id}` : `ip:${req.ip}`);

// Per-endpoint-class limiter for the authenticated wallet REST API. Separate
// from the global /api IP limiter in app.js so a shared IP (NAT, proxy) can't
// starve other accounts, and so sensitive routes (e.g. send) can carry a
// tighter policy than read-only ones.
const createAccountRateLimit = ({ windowMs, max, prefix }) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateStore(prefix),
  keyGenerator: accountOrIpKey,
  handler: (req, _res, next) => {
    increment('sendam_rate_limit_exceeded_total', {
      scope: req.restUser && req.restUser.id ? 'account' : 'ip',
      route: req.baseUrl + (req.route ? req.route.path : req.path),
    });
    next(new AppError('rate_limited'));
  },
});

module.exports = createAccountRateLimit;
