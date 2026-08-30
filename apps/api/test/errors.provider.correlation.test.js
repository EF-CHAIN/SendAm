const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { outboundHeaders, runWithContext } = require('../src/observability/context');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// Shared config mock so every provider module loaded in this file sees a valid
// (minimal) environment, matching how the rest of the suite injects config.
injectMock('config/env', {
  messageTransport: 'meta',
  whatsapp: { phoneNumberId: '123456', token: 'tok', appId: 'app' },
  compliance: {
    smileId: {
      partnerId: '023',
      apiKey: 'test-secret',
      callbackUrl: 'https://example.test/callback',
      baseUrl: 'https://testapi.smileidentity.com/v2/verify_async',
      timeoutMs: 1000,
      callbackToleranceMs: 300000,
    },
  },
});

test('outboundHeaders returns nothing outside a correlation context', () => {
  assert.deepEqual(outboundHeaders(), {});
});

test('outboundHeaders carries the in-flight correlation id to providers', () => {
  runWithContext({ correlationId: 'provider-corr-1' }, () => {
    assert.deepEqual(outboundHeaders(), { 'x-correlation-id': 'provider-corr-1' });
  });
});

test('Smile ID submission propagates the correlation id header', async () => {
  const axiosPost = mock.fn(async () => ({ data: { success: true } }));
  require.cache[require.resolve('axios')] = {
    id: require.resolve('axios'),
    filename: require.resolve('axios'),
    loaded: true,
    exports: { post: axiosPost },
  };

  const provider = require('../src/compliance/smileId.provider');
  await runWithContext({ correlationId: 'provider-corr-2' }, () => provider.submitVerification({
    jobId: 'job-1',
    userId: 'user-1',
    phoneNumber: '+2348000000000',
    applicant: { country: 'NG', idType: 'NIN', idNumber: '123', firstName: 'Ada', lastName: 'Okafor' },
  }));
  const [, , options] = axiosPost.mock.calls[0].arguments;
  assert.equal(options.headers['x-correlation-id'], 'provider-corr-2');
});

test('WhatsApp send propagates the correlation id header', async () => {
  let seenOptions;
  const fakeAxios = {
    post: async (_url, _payload, options) => { seenOptions = options; return { data: { messages: [{ id: 'm1' }] } }; },
  };
  const { sendTextMessage } = require('../src/services/whatsapp.service');
  await runWithContext({ correlationId: 'provider-corr-3' }, () => sendTextMessage('+2348000000000', 'hello', {
    messageTransport: 'meta',
    axiosImpl: fakeAxios,
  }));
  assert.equal(seenOptions.headers['x-correlation-id'], 'provider-corr-3');
});
