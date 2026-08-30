const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const {
  parseConsentCommand,
  updateUserConsent,
  isMessageAllowed,
} = require('../src/compliance/consent.service');

test('parseConsentCommand identifies STOP and START keywords', () => {
  assert.deepEqual(parseConsentCommand('STOP'), { isConsentCommand: true, consent: 'opted_out', command: 'STOP' });
  assert.deepEqual(parseConsentCommand('unsubscribe'), { isConsentCommand: true, consent: 'opted_out', command: 'UNSUBSCRIBE' });
  assert.deepEqual(parseConsentCommand('START'), { isConsentCommand: true, consent: 'opted_in', command: 'START' });
  assert.deepEqual(parseConsentCommand('subscribe'), { isConsentCommand: true, consent: 'opted_in', command: 'SUBSCRIBE' });
  assert.deepEqual(parseConsentCommand('send 100 to john'), { isConsentCommand: false });
});

test('updateUserConsent updates user consent and writes audit log', async () => {
  let updatedUserData;
  let auditLogData;

  const fakeDb = {
    user: {
      update: async (args) => {
        updatedUserData = args;
        return { id: 'u123', phoneNumber: '+12345', messagingConsent: args.data.messagingConsent };
      },
    },
    auditLog: {
      create: async (args) => {
        auditLogData = args;
        return { id: 'audit_1' };
      },
    },
  };

  const user = await updateUserConsent({
    userId: 'u123',
    phoneNumber: '+12345',
    consent: 'opted_out',
    source: 'whatsapp_keyword',
    prisma: fakeDb,
  });

  assert.equal(user.messagingConsent, 'opted_out');
  assert.equal(updatedUserData.data.messagingConsent, 'opted_out');
  assert.equal(updatedUserData.data.consentSource, 'whatsapp_keyword');
  assert.equal(auditLogData.data.action, 'messaging_consent_updated');
  assert.equal(auditLogData.data.metadata.consent, 'opted_out');
});

test('isMessageAllowed blocks promotional messages for opted_out users but permits transactional', () => {
  const optedOutUser = { id: 'u1', messagingConsent: 'opted_out' };
  const optedInUser = { id: 'u2', messagingConsent: 'opted_in' };

  assert.equal(isMessageAllowed({ user: optedOutUser, isTransactional: false }), false);
  assert.equal(isMessageAllowed({ user: optedOutUser, isTransactional: true }), true);
  assert.equal(isMessageAllowed({ user: optedOutUser, messageCategory: 'essential' }), true);
  assert.equal(isMessageAllowed({ user: optedInUser, isTransactional: false }), true);
});
