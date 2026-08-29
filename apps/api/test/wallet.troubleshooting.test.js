const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletTroubleshootingService } = require('../src/support/walletTroubleshooting.service');

test('WalletTroubleshootingService - diagnoses unfunded account', () => {
  const service = new WalletTroubleshootingService();
  const diagnosis = service.diagnoseWalletState({
    customerName: 'Alice',
    walletAddress: 'GBX111',
    hasAccount: false,
    xlmBalance: 0,
  });

  assert.equal(diagnosis.code, 'UNFUNDED_ACCOUNT');
  assert.ok(diagnosis.customerTemplate.includes('1.5 XLM'));
  assert.ok(diagnosis.agentAction.includes('Instruct customer'));
});

test('WalletTroubleshootingService - diagnoses missing trustline for USDC', () => {
  const service = new WalletTroubleshootingService();
  const diagnosis = service.diagnoseWalletState({
    customerName: 'Bob',
    walletAddress: 'GBX222',
    hasAccount: true,
    xlmBalance: 5,
    trustlines: [],
    requestedAsset: 'USDC',
    requestedAssetIssuer: 'GA5ZSE...USDC',
  });

  assert.equal(diagnosis.code, 'MISSING_TRUSTLINE');
  assert.ok(diagnosis.customerTemplate.includes('ADD TRUSTLINE USDC'));
});

test('WalletTroubleshootingService - returns healthy status when all conditions met', () => {
  const service = new WalletTroubleshootingService();
  const diagnosis = service.diagnoseWalletState({
    customerName: 'Charlie',
    walletAddress: 'GBX333',
    hasAccount: true,
    xlmBalance: 10,
    trustlines: [{ assetCode: 'USDC' }],
    requestedAsset: 'USDC',
  });

  assert.equal(diagnosis.code, 'HEALTHY');
  assert.ok(diagnosis.customerTemplate.includes('fully active'));
});
