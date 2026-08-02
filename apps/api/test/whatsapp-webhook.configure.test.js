const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  requireConfiguration,
  configureWebhook,
} = require('../scripts/configure-whatsapp-webhook');

const env = {
  WHATSAPP_CALLBACK_URL: 'https://api.example.com/webhook',
  WHATSAPP_VERIFY_TOKEN: 'verify-secret-at-least-32-characters',
  WHATSAPP_APP_SECRET: 'app-secret',
  WHATSAPP_TOKEN: 'system-user-token',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '1234567890',
  META_GRAPH_API_VERSION: 'v99.0',
};

test('configuration validation rejects incomplete or unsafe production settings', () => {
  assert.throws(() => requireConfiguration({}), /Missing configuration/);
  assert.throws(
    () => requireConfiguration({ ...env, WHATSAPP_CALLBACK_URL: 'http://api.example.com/webhook' }),
    /must use HTTPS/,
  );
  assert.throws(
    () => requireConfiguration({ ...env, WHATSAPP_CALLBACK_URL: 'https://api.example.com/wrong' }),
    /must end in \/webhook/,
  );
  assert.throws(
    () => requireConfiguration({ ...env, META_GRAPH_API_VERSION: 'latest' }),
    /must look like vXX.X/,
  );
});

test('configures Meta, confirms readback, and validates both signature paths', async () => {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    if (url.startsWith(env.WHATSAPP_CALLBACK_URL + '?')) {
      return new Response(new URL(url).searchParams.get('hub.challenge'), { status: 200 });
    }
    if (url.includes('/subscribed_apps') && options.method === 'POST') {
      assert.equal(options.headers.authorization, 'Bearer system-user-token');
      assert.deepEqual(JSON.parse(options.body), {
        override_callback_uri: env.WHATSAPP_CALLBACK_URL,
        verify_token: env.WHATSAPP_VERIFY_TOKEN,
      });
      return Response.json({ success: true });
    }
    if (url.includes('/subscribed_apps')) {
      return Response.json({ data: [{ override_callback_uri: env.WHATSAPP_CALLBACK_URL }] });
    }
    if (options.headers['x-hub-signature-256'] === `sha256=${'0'.repeat(64)}`) {
      return new Response('Forbidden', { status: 403 });
    }
    return new Response('EVENT_RECEIVED', { status: 200 });
  };

  const result = await configureWebhook({ fetchImpl, env });
  assert.equal(result.event, 'whatsapp_webhook_configuration_verified');
  assert.equal(result.callbackHost, 'api.example.com');
  assert.equal(calls.length, 5);
});

test('fails when Meta readback does not contain the production callback', async () => {
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    if (url.startsWith(env.WHATSAPP_CALLBACK_URL + '?')) {
      return new Response(new URL(url).searchParams.get('hub.challenge'), { status: 200 });
    }
    if (options.method === 'POST') return Response.json({ success: true });
    return Response.json({ data: [{ override_callback_uri: 'https://wrong.example/webhook' }] });
  };
  await assert.rejects(
    () => configureWebhook({ fetchImpl, env }),
    /readback did not contain/,
  );
});

test('fails without leaking the access token when Meta rejects configuration', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith(env.WHATSAPP_CALLBACK_URL + '?')) {
      return new Response(new URL(url).searchParams.get('hub.challenge'), { status: 200 });
    }
    return Response.json({ error: { message: 'permission denied' } }, { status: 403 });
  };
  await assert.rejects(
    () => configureWebhook({ fetchImpl, env }),
    (error) => error.message.includes('permission denied') && !error.message.includes(env.WHATSAPP_TOKEN),
  );
});
