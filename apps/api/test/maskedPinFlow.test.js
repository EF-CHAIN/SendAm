const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  maskPin,
  buildPinSecurityGuidance,
  generateEphemeralPinToken,
  verifyEphemeralPinToken,
  getWebPinEntryUrl,
  sendMaskedPinFeedback,
  processPinVerification,
} = require('../src/whatsapp/pinFlow');
const { hashPin } = require('../src/compliance/pin.service');

describe('Masked WhatsApp PIN Flow (#977)', () => {
  test('maskPin masks 4-digit and 6-digit PINs properly', () => {
    assert.equal(maskPin('1234'), '****');
    assert.equal(maskPin('123456'), '******');
    assert.equal(maskPin(null), '****');
    assert.equal(maskPin(''), '****');
  });

  test('buildPinSecurityGuidance contains masked asterisks and chat deletion guidance', () => {
    const guidance = buildPinSecurityGuidance('4321');
    assert.equal(guidance.includes('****'), true);
    assert.equal(guidance.includes('delete your PIN message from this chat'), true);
    // Crucial: Raw PIN must never appear in guidance
    assert.equal(guidance.includes('4321'), false);
  });

  test('generateEphemeralPinToken creates signed token and verifies payload', () => {
    const token = generateEphemeralPinToken({
      userId: 'user_123',
      stateId: 'ps_abc_456',
      expiresInMs: 60000,
    });

    assert.ok(token);
    assert.equal(token.includes('.'), true);

    const verified = verifyEphemeralPinToken(token);
    assert.ok(verified);
    assert.equal(verified.userId, 'user_123');
    assert.equal(verified.stateId, 'ps_abc_456');
    assert.ok(verified.exp > Date.now());
  });

  test('verifyEphemeralPinToken rejects expired or tampered token', () => {
    // Expired token
    const expiredToken = generateEphemeralPinToken({
      userId: 'user_123',
      stateId: 'ps_abc_456',
      expiresInMs: -1000,
    });
    assert.equal(verifyEphemeralPinToken(expiredToken), null);

    // Tampered token
    const token = generateEphemeralPinToken({ userId: 'user_123', stateId: 'ps_1' });
    const [payload, sig] = token.split('.');
    const tampered = `${payload}.invalidSignature123`;
    assert.equal(verifyEphemeralPinToken(tampered), null);
    assert.equal(verifyEphemeralPinToken('not-a-token'), null);
  });

  test('getWebPinEntryUrl formats valid web link', () => {
    const token = 'payload.sig';
    const url = getWebPinEntryUrl(token);
    assert.ok(url.includes('/auth/pin?token=payload.sig'));
  });

  test('processPinVerification provides masked feedback and verifies valid PIN', async () => {
    const testPin = '5678';
    const pinHash = hashPin(testPin);

    const user = { id: 'u_test_pin_1', pinHash };
    const notifications = [];
    const notify = async (to, msg) => notifications.push(msg);

    const mockPrisma = {
      user: {
        findUnique: async () => user,
      },
    };

    const result = await processPinVerification({
      prisma: mockPrisma,
      user,
      rawPin: testPin,
      notify,
      phoneNumber: '+2348011223344',
    });

    assert.equal(result.ok, true);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].includes('****'), true);
    assert.equal(notifications[0].includes('delete your PIN message from this chat'), true);
    // Ensure raw PIN was not leaked in notification
    assert.equal(notifications[0].includes(testPin), false);
  });

  test('processPinVerification provides masked feedback when invalid PIN is entered', async () => {
    const correctPin = '5678';
    const wrongPin = '1111';
    const pinHash = hashPin(correctPin);

    const user = { id: 'u_test_pin_2', pinHash };
    const notifications = [];
    const notify = async (to, msg) => notifications.push(msg);

    const mockPrisma = {
      user: {
        findUnique: async () => user,
      },
    };

    const result = await processPinVerification({
      prisma: mockPrisma,
      user,
      rawPin: wrongPin,
      notify,
      phoneNumber: '+2348011223344',
    });

    assert.equal(result.ok, false);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].includes('****'), true);
    assert.equal(notifications[0].includes('delete your PIN message from this chat'), true);
    assert.equal(notifications[0].includes(wrongPin), false);
  });
});
