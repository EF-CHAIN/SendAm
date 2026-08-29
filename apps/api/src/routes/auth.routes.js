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
router.get('/challenge', authLimiter, controller.challenge);
router.post('/token', authLimiter, controller.token);
router.post('/logout', requireRestSession, controller.logout);
module.exports = router;
