const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentIdempotencyService } = require('../src/payment/idempotency.service');

test('PaymentIdempotencyService - processes unique instruction correctly', () => {
  const service = new PaymentIdempotencyService();
  const result = service.processInstruction({
    senderId: 'usr_101',
    recipientAddress: 'GBX1234567890STEL',
    amount: 100,
    assetCode: 'XLM',
  });

  assert.equal(result.isDuplicate, false);
  assert.ok(result.idempotencyKey.includes('usr_101'));
  assert.equal(result.record.status, 'PENDING');
});

test('PaymentIdempotencyService - detects duplicate payment instruction and records attempt', () => {
  const service = new PaymentIdempotencyService();
  const paymentData = {
    idempotencyKey: 'ik_custom_999',
    senderId: 'usr_101',
    recipientAddress: 'GBX1234567890STEL',
    amount: 50,
  };

  const first = service.processInstruction(paymentData);
  assert.equal(first.isDuplicate, false);

  const duplicate = service.processInstruction(paymentData);
  assert.equal(duplicate.isDuplicate, true);
  assert.equal(duplicate.existingRecord.attemptCount, 2);

  const trace = service.getSettlementTrace('ik_custom_999');
  assert.equal(trace.attempts.length, 2);
  assert.equal(trace.attempts[1].status, 'DUPLICATE_REJECTED');
});

test('PaymentIdempotencyService - tracks settlement status updates', () => {
  const service = new PaymentIdempotencyService();
  const key = 'ik_tx_test';
  service.processInstruction({ idempotencyKey: key, senderId: 'u1', recipientAddress: 'r1', amount: 10 });

  service.updateStatus(key, 'SETTLED', { txHash: '0x123abc' });
  const trace = service.getSettlementTrace(key);

  assert.equal(trace.instruction.status, 'SETTLED');
  assert.equal(trace.instruction.metadata.txHash, '0x123abc');
});
