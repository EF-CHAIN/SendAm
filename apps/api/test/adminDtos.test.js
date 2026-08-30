const { test } = require('node:test');
const assert = require('node:assert/strict');
const { userDto, walletDto, transactionDto, kycProfileDto } = require('../src/admin/adminDtos');

const forbidden = new Set([
  'pinHash', 'pinSetAt', 'pendingSend', 'contactsJson', 'encryptedSecretKey',
  'paymentCursor', 'metadata', 'providerReference', 'providerTransactionId', 'deniedReason',
]);

const assertNoSensitiveKeys = (value) => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `sensitive field leaked: ${key}`);
    assertNoSensitiveKeys(child);
  }
};

const common = { id: 'id_1', createdAt: new Date(), updatedAt: new Date() };

test('admin list DTOs omit sensitive model fields instead of setting undefined', () => {
  const records = [
    userDto({ ...common, phoneNumber: '+2348012345678', whatsappName: 'Ada', kycTier: 1, pinHash: 'secret', pendingSend: {}, contactsJson: {}, wallets: [] }),
    walletDto({ ...common, chain: 'stellar', network: 'testnet', funded: true, publicKey: 'GABCDEF123456789', encryptedSecretKey: 'secret', paymentCursor: 'cursor', user: { id: 'u1', phoneNumber: '+2348012345678' } }),
    transactionDto({ ...common, type: 'send', amount: '5', asset: 'XLM', rail: 'stellar', routeType: 'domestic', status: 'success', destination: 'GABCDEF123456789', recipientPhoneNumber: '+2348012345678', txHash: 'hash123456789', metadata: { secret: true }, providerTransactionId: 'provider', user: { id: 'u1', phoneNumber: '+2348012345678' } }),
    kycProfileDto({ ...common, tier: 1, status: 'pending', country: 'NG', riskScore: 2, sanctionsStatus: 'clear', custodyStatus: 'approved', metadata: {}, providerReference: 'secret', deniedReason: 'secret', user: { id: 'u1', phoneNumber: '+2348012345678' } }),
  ];

  records.forEach(assertNoSensitiveKeys);
  assert.notEqual(records[0].phoneNumber, '+2348012345678');
  assert.notEqual(records[1].publicKey, 'GABCDEF123456789');
  assert.notEqual(records[2].destination, 'GABCDEF123456789');
});
