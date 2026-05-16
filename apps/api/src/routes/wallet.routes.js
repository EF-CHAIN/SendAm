const express = require('express');
const router = express.Router();
const walletController = require('../controllers/wallet.controller');

router.post('/create', walletController.createWallet);
router.get('/:phone/balance', walletController.checkBalance);
router.post('/send', walletController.sendFunds);

module.exports = router;
