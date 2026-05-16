const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');

router.get('/stats', adminController.getStats);
router.get('/users', adminController.getUsers);
router.get('/wallets', adminController.getWallets);
router.get('/transactions', adminController.getTransactions);

module.exports = router;
