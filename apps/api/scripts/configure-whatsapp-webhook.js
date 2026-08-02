const crypto = require('node:crypto');

const requireConfiguration = (env) => {
  const names = [
    'WHATSAPP_CALLBACK_URL',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_TOKEN',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'META_GRAPH_API_VERSION',
  ];
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  const callback = new URL(env.WHATSAPP_CALLBACK_URL);
  if (callback.protocol !== 'https:') throw new Error('WHATSAPP_CALLBACK_URL must use HTTPS');
  if (!callback.pathname.endsWith('/webhook') || callback.search || callback.hash) {
    throw new Error('WHATSAPP_CALLBACK_URL must end in /webhook without query parameters or a fragment');
  }
  if (!/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION)) {
    throw new Error('META_GRAPH_API_VERSION must look like vXX.X');
  }
  if (!/^\d+$/.test(env.WHATSAPP_BUSINESS_ACCOUNT_ID)) {
    throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID must contain digits only');
  }
  if (env.WHATSAPP_VERIFY_TOKEN.length < 32) {
    throw new Error('WHATSAPP_VERIFY_TOKEN must be at least 32 characters');
  }
};

const responseBody = async (response) => {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
};

const expectResponse = async (response, label) => {
  const body = await responseBody(response);
  if (!response.ok) {
    const providerMessage = body?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`${label} failed: ${providerMessage}`);
  }
  return body;
};

const verifyHandshake = async (fetchImpl, env) => {
  const challenge = crypto.randomBytes(24).toString('hex');
  const url = new URL(env.WHATSAPP_CALLBACK_URL);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', env.WHATSAPP_VERIFY_TOKEN);
  url.searchParams.set('hub.challenge', challenge);
  const response = await fetchImpl(url);
  const body = await response.text();
  if (!response.ok || body !== challenge) throw new Error('Deployed webhook verification handshake failed');
};

const configureSubscription = async (fetchImpl, env) => {
  const endpoint = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`
    + `/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`;
  const headers = {
    authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
    'content-type': 'application/json',
  };
  await expectResponse(await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      override_callback_uri: env.WHATSAPP_CALLBACK_URL,
      verify_token: env.WHATSAPP_VERIFY_TOKEN,
    }),
  }), 'Meta webhook subscription');

  const subscriptions = await expectResponse(
    await fetchImpl(endpoint, { headers: { authorization: headers.authorization } }),
    'Meta webhook subscription readback',
  );
  const configured = subscriptions.data?.some(
    (subscription) => subscription.override_callback_uri === env.WHATSAPP_CALLBACK_URL,
  );
  if (!configured) throw new Error('Meta subscription readback did not contain the configured callback URL');
};

const verifySignatures = async (fetchImpl, env) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const digest = crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(body).digest('hex');
  const valid = await fetchImpl(env.WHATSAPP_CALLBACK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${digest}` },
    body,
  });
  if (!valid.ok) throw new Error(`Signed webhook smoke test failed with HTTP ${valid.status}`);

  const invalid = await fetchImpl(env.WHATSAPP_CALLBACK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
    body,
  });
  if (invalid.status !== 403) throw new Error('Invalid webhook signature was not rejected');
};

const configureWebhook = async ({ fetchImpl = fetch, env = process.env } = {}) => {
  requireConfiguration(env);
  await verifyHandshake(fetchImpl, env);
  await configureSubscription(fetchImpl, env);
  await verifySignatures(fetchImpl, env);
  return {
    event: 'whatsapp_webhook_configuration_verified',
    callbackHost: new URL(env.WHATSAPP_CALLBACK_URL).host,
    businessAccountIdSuffix: env.WHATSAPP_BUSINESS_ACCOUNT_ID.slice(-4),
  };
};

if (require.main === module) {
  configureWebhook()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(JSON.stringify({ event: 'whatsapp_webhook_configuration_failed', error: error.message }));
      process.exit(1);
    });
}

module.exports = {
  requireConfiguration,
  verifyHandshake,
  configureSubscription,
  verifySignatures,
  configureWebhook,
};
