const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/auth.controller');
const requireRestSession = require('../middlewares/requireRestSession');
const PostgresRateStore = require('../middlewares/postgresRateStore');

const router = express.Router();
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateStore('auth:'),
});

const bodyParsers = [
  express.json(),
  express.urlencoded({ extended: false }),
];

// Standard SEP-10 endpoints: GET /auth and POST /auth (mounted at /auth and /api/auth)
router.get('/', authLimiter, controller.sep10Challenge);
router.post('/', authLimiter, ...bodyParsers, controller.sep10Token);
router.post('/refresh', authLimiter, ...bodyParsers, controller.sep10Refresh);
router.post('/revoke', authLimiter, ...bodyParsers, controller.sep10Revoke);

// Internal REST session auth endpoints
router.get('/challenge', authLimiter, controller.challenge);
router.post('/token', authLimiter, ...bodyParsers, controller.token);
router.post('/logout', requireRestSession, controller.logout);

module.exports = router;
