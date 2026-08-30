const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAddress,
  isMuxedAddress,
  getBaseAccountId,
  validateMemo,
  buildStellarMemo,
  redactMemo,
  submitPayment,
} = require('../src/wallet/stellar.adapter');

test('Stellar address validation supports classic Ed25519 and Med25519 Muxed addresses', () => {
  const classicG = 'GDQSPGG3XYPVEEOQZB3BCNZAZP2YABHNSMV7677DSGUFW7ZRK26TRK3A';
  const muxedM = 'MDQSPGG3XYPVEEOQZB3BCNZAZP2YABHNSMV7677DSGUFW7ZRK26TQAAAAAAAAABQHGYGG';
  const invalid = 'NOT_A_STELLAR_ADDRESS';

  assert.equal(validateAddress(classicG), true);
  assert.equal(validateAddress(muxedM), true);
  assert.equal(validateAddress(invalid), false);

  assert.equal(isMuxedAddress(classicG), false);
  assert.equal(isMuxedAddress(muxedM), true);

  assert.equal(getBaseAccountId(muxedM), classicG);
  assert.equal(getBaseAccountId(classicG), classicG);
});

test('Stellar memo validation enforces format and byte limits per type', () => {
  // Text memo (max 28 bytes)
  assert.equal(validateMemo({ memo: 'hello world', memoType: 'text' }), true);
  assert.throws(
    () => validateMemo({ memo: 'a'.repeat(29), memoType: 'text' }),
    /Invalid text memo: maximum 28 bytes allowed/
  );

  // ID memo (unsigned 64-bit integer string)
  assert.equal(validateMemo({ memo: '1234567890', memoType: 'id' }), true);
  assert.throws(
    () => validateMemo({ memo: 'not-a-number', memoType: 'id' }),
    /Invalid id memo: must be a numeric integer string/
  );
  assert.throws(
    () => validateMemo({ memo: '18446744073709551616', memoType: 'id' }),
    /Invalid id memo: must fit in an unsigned 64-bit integer/
  );

  // Hash / Return memo (32-byte hex string or Buffer)
  const validHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  assert.equal(validateMemo({ memo: validHex, memoType: 'hash' }), true);
  assert.equal(validateMemo({ memo: Buffer.alloc(32), memoType: 'return' }), true);
  assert.throws(
    () => validateMemo({ memo: 'short-hex', memoType: 'hash' }),
    /Invalid hash memo: must be a 32-byte hex string/
  );
});

test('buildStellarMemo constructs correct Stellar SDK Memo instances', () => {
  const textMemo = buildStellarMemo({ memo: 'Invoice 1024', memoType: 'text' });
  assert.equal(textMemo._type, 'text');
  assert.equal(textMemo._value, 'Invoice 1024');

  const idMemo = buildStellarMemo({ memo: '987654321', memoType: 'id' });
  assert.equal(idMemo._type, 'id');
  assert.equal(idMemo._value, '987654321');
});

test('redactMemo masks sensitive memo strings safely', () => {
  assert.equal(redactMemo('123456789'), '12***89');
  assert.equal(redactMemo('abc'), '****');
  assert.equal(redactMemo(''), '');
  assert.equal(redactMemo(null), '');
});

test('submitPayment rejects conflicting Muxed address + explicit memo combination', async () => {
  const muxedM = 'MDQSPGG3XYPVEEOQZB3BCNZAZP2YABHNSMV7677DSGUFW7ZRK26TQAAAAAAAAABQHGYGG';
  const dummySecret = 'SDDummySecretKeyPlaceholderForTest12345678901234567890';

  await assert.rejects(
    submitPayment({
      secretKey: dummySecret,
      destination: muxedM,
      amount: '10.0000000',
      asset: 'XLM',
      memo: '12345',
      memoType: 'id',
    }),
    /Muxed account destination already includes an embedded ID; providing a separate memo is conflicting/
  );
});
