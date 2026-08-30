const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const axiosPost = mock.fn(async () => ({ data: { success: true } }));
injectMock('config/env', {
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
require.cache[require.resolve('axios')] = {
  id: require.resolve('axios'),
  filename: require.resolve('axios'),
  loaded: true,
  exports: { post: axiosPost },
};

const provider = require('../src/compliance/smileId.provider');

test('submits an asynchronous Smile ID Basic KYC job with a stable job id', async () => {
  await provider.submitVerification({
    jobId: 'sendam-profile_1',
    userId: 'user_1',
    phoneNumber: '+2348000000000',
    applicant: {
      country: 'NG', idType: 'NIN', idNumber: '123', firstName: 'Ada', lastName: 'Okafor',
    },
  });
  assert.equal(axiosPost.mock.callCount(), 1);
  const [url, body] = axiosPost.mock.calls[0].arguments;
  assert.equal(url, 'https://testapi.smileidentity.com/v2/verify_async');
  assert.equal(body.partner_params.job_id, 'sendam-profile_1');
  assert.equal(body.callback_url, 'https://example.test/callback');
  assert.ok(body.signature);
});

test('accepts a fresh authentic callback signature', () => {
  const timestamp = new Date().toISOString();
  assert.equal(provider.verifyCallback({ signature: provider.signatureFor(timestamp), timestamp }), true);
});

test('rejects tampered and expired callback signatures', () => {
  const timestamp = new Date().toISOString();
  assert.equal(provider.verifyCallback({ signature: crypto.randomBytes(32).toString('base64'), timestamp }), false);
  const expired = new Date(Date.now() - 301000).toISOString();
  assert.equal(provider.verifyCallback({ signature: provider.signatureFor(expired), timestamp: expired }), false);
});
