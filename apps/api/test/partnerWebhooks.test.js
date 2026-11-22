const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const pw = require('../src/services/partnerWebhooks');
const { resetMetrics } = require('../src/observability/metrics');

beforeEach(() => resetMetrics());

const SECRET = 'super-secret-signing-key';
const fakeCrypto = { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, '') };
const partner = (webhook, status = 'active') => ({ id: 'p1', status, config: { webhook } });
const hookConfig = () => pw.buildWebhookConfig({ url: 'https://partner.example/hook', secret: SECRET }, { cryptoService: fakeCrypto });

const harness = ({ partnerRow, response, error, attemptsMade = 0 }) => {
  const audits = [];
  const posts = [];
  let t = 1_700_000_000_000;
  const deps = {
    db: { partner: { findUnique: async () => partnerRow } },
    httpClient: {
      post: async (url, body, opts) => {
        posts.push({ url, body, opts });
        t += 42;
        if (error) throw error;
        return response;
      },
    },
    audit: async (e) => { audits.push(e); },
    cryptoService: fakeCrypto,
    allowInsecure: false,
    now: () => t,
  };
  const job = { data: { partnerId: 'p1', eventType: 'payment.settled', payload: { amount: '5' }, deliveryId: 'whd_1' }, attemptsMade };
  return { deps, job, audits, posts };
};

test('signature is HMAC-SHA256 over timestamp.body and verifies', () => {
  const sig = pw.signPayload(SECRET, '1700000000', '{"a":1}');
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  const base = { secret: SECRET, timestamp: '1700000000', body: '{"a":1}', signature: sig, now: 1_700_000_000_000 };
  assert.equal(pw.verifySignature(base), true);
  assert.equal(pw.verifySignature({ ...base, body: '{"a":2}' }), false);
  assert.equal(pw.verifySignature({ ...base, secret: 'other-secret-value' }), false);
  assert.equal(pw.verifySignature({ ...base, now: 1_700_000_000_000 + 10 * 60 * 1000 }), false, 'stale timestamp rejected');
});

test('successful delivery sends signed headers and audits status + latency', async () => {
  const { deps, job, audits, posts } = harness({ partnerRow: partner(hookConfig()), response: { status: 200 } });
  const result = await pw.processPartnerWebhookJob(job, deps);
  assert.equal(result.delivered, true);
  const { headers } = posts[0].opts;
  assert.equal(posts[0].opts.maxRedirects, 0);
  assert.ok(pw.verifySignature({
    secret: SECRET,
    timestamp: headers['X-SendAm-Timestamp'],
    body: posts[0].body,
    signature: headers['X-SendAm-Signature'],
    now: 1_700_000_000_000 + 42,
  }));
  assert.equal(headers['X-SendAm-Event'], 'payment.settled');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'partner_webhook.delivery');
  assert.equal(audits[0].metadata.status, 'delivered');
  assert.equal(audits[0].metadata.latencyMs, 42);
  assert.equal(audits[0].metadata.responseStatus, 200);
  assert.ok(!JSON.stringify(audits[0]).includes(SECRET));
});

test('non-2xx and network errors throw (so BullMQ retries) and are audited', async () => {
  const bad = harness({ partnerRow: partner(hookConfig()), response: { status: 500 }, attemptsMade: 2 });
  await assert.rejects(pw.processPartnerWebhookJob(bad.job, bad.deps), /500/);
  assert.equal(bad.audits[0].metadata.status, 'failed');
  assert.equal(bad.audits[0].metadata.attempt, 3);

  const net = harness({ partnerRow: partner(hookConfig()), error: Object.assign(new Error('x'), { code: 'ECONNRESET' }) });
  await assert.rejects(pw.processPartnerWebhookJob(net.job, net.deps), /ECONNRESET/);
  assert.equal(net.audits[0].metadata.error, 'ECONNRESET');
});

test('missing, suspended or unconfigured partners are skipped without retry', async () => {
  for (const row of [null, partner(hookConfig(), 'suspended'), partner(undefined)]) {
    const h = harness({ partnerRow: row, response: { status: 200 } });
    const out = await pw.processPartnerWebhookJob(h.job, h.deps);
    assert.equal(out.skipped, true);
    assert.equal(h.posts.length, 0);
    assert.equal(h.audits[0].metadata.status, 'skipped');
  }
});

test('private or non-https endpoints are refused', () => {
  const bad = [
    'http://partner.example/h',
    'https://localhost/h',
    'https://10.0.0.5/h',
    'https://169.254.169.254/',
    'https://[::1]/h',
    'https://u:p@partner.example/',
  ];
  for (const url of bad) assert.throws(() => pw.validateWebhookUrl(url), undefined, url);
  assert.equal(pw.validateWebhookUrl('https://partner.example/h'), 'https://partner.example/h');
});

test('stored config encrypts the secret and rejects weak ones', () => {
  const cfg = hookConfig();
  assert.equal(cfg.secret, undefined);
  assert.equal(cfg.secretEncrypted, `enc:${SECRET}`);
  assert.throws(() => pw.buildWebhookConfig({ url: 'https://partner.example/h', secret: 'short' }, { cryptoService: fakeCrypto }));
});

test('dispatch enqueues with 6 attempts (1 + 5 retries) and exponential backoff', async () => {
  const calls = [];
  const { deliveryId } = await pw.dispatchPartnerWebhook({
    partnerId: 'p1',
    eventType: 'payment.settled',
    payload: {},
    enqueue: async (...a) => { calls.push(a); return { id: 'j' }; },
  });
  const [queue, name, data, opts] = calls[0];
  assert.equal(queue, 'partner-webhooks');
  assert.equal(name, 'partner.webhook');
  assert.equal(data.deliveryId, deliveryId);
  assert.equal(opts.attempts, 6);
  assert.equal(opts.backoff.type, 'exponential');
  assert.equal(opts.jobId, deliveryId);
  await assert.rejects(pw.dispatchPartnerWebhook({ eventType: 'x' }));
});
