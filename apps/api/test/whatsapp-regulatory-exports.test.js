const assert = require('node:assert/strict');
const { test } = require('node:test');
const { matchContacts } = require('../src/services/contactMatcher');
const { createMessageDedup } = require('../src/middlewares/dedupMessages');
const { sendVoiceReceipt } = require('../src/voice/voiceReceipt');
const { csvReport, reportFilters, transactionRows } = require('../src/admin/controllers/complianceExport.controller');
const config = require('../src/config/env');

test('misspellings only surface close saved contacts, with duplicate destinations removed', () => {
  const contacts = [
    { label: 'Chizom', target: 'first' },
    { label: 'Chizóm', target: 'first' },
    { label: 'Chison', target: 'second' },
    { label: 'Musa', target: 'third' },
  ];
  assert.deepEqual(new Set(matchContacts('Chisom', contacts).map(({ target }) => target)), new Set(['first', 'second']));
  assert.deepEqual(matchContacts('Chisom', contacts.slice(0, 1)), contacts.slice(0, 1));
  assert.deepEqual(matchContacts('Unknown', contacts), []);
});

test('Redis only caches accepted keys and misses safely when unavailable', async () => {
  const cached = new Map();
  const connection = {
    get: async (key) => cached.get(key),
    set: async (key, value, nx, ex, seconds) => {
      assert.deepEqual([nx, ex, seconds], ['NX', 'EX', 300]);
      if (!cached.has(key)) cached.set(key, value);
    },
  };
  const cache = createMessageDedup(() => connection);
  assert.equal(await cache.has('retry'), false);
  await cache.remember('accepted');
  assert.equal(await cache.has('accepted'), true);
  assert.equal(await cache.has('retry'), false);
  const unavailable = createMessageDedup(() => { throw new Error('Redis offline'); });
  assert.equal(await unavailable.has('accepted'), false);
  await unavailable.remember('retry');
});

test('confirmed Stellar payments synthesize Opus and dispatch a WhatsApp voice note', async (t) => {
  const oldKey = process.env.DEEPGRAM_TTS_API_KEY;
  const oldTransport = config.messageTransport;
  process.env.DEEPGRAM_TTS_API_KEY = 'test';
  config.messageTransport = 'meta';
  t.after(() => {
    if (oldKey === undefined) delete process.env.DEEPGRAM_TTS_API_KEY;
    else process.env.DEEPGRAM_TTS_API_KEY = oldKey;
    config.messageTransport = oldTransport;
  });
  const steps = [];
  const deps = {
    phoneNumber: '+2348000000001',
    transaction: { status: 'success', amount: '10', asset: 'XLM', fiatAmount: '5000', fiatCurrency: 'NGN' },
    label: 'Musa',
    fetchImpl: async (url, { body, signal }) => {
      assert.match(url, /encoding=opus&container=ogg/);
      assert.match(JSON.parse(body).text, /10 XLM to Musa/);
      assert.equal(signal.aborted, false);
      steps.push('synthesize');
      return new Response('OggS');
    },
    upload: async (endpoint, form) => {
      assert.equal(endpoint, 'media');
      assert.equal(form.get('file').type, 'audio/ogg; codecs=opus');
      assert.equal(await form.get('file').text(), 'OggS');
      steps.push('upload');
      return { id: 'media-id' };
    },
    send: async (to, type, audio) => {
      assert.equal(to, deps.phoneNumber);
      assert.equal(type, 'audio');
      assert.deepEqual(audio, { id: 'media-id', voice: true });
      steps.push('send');
    },
  };
  await sendVoiceReceipt({ ...deps, transaction: { status: 'pending' } });
  assert.deepEqual(steps, []);
  await sendVoiceReceipt({ ...deps, transaction: { ...deps.transaction, status: 'pending' }, ledgerConfirmed: true });
  assert.deepEqual(steps, ['synthesize', 'upload', 'send']);
});

test('regulatory filters preserve decimal precision and use the recorded risk score and corridor', () => {
  assert.deepEqual(reportFilters({ corridor: 'ng-gh', minAmount: '123456789.0000001', riskTier: 'high' }), {
    AND: [
      { metadata: { path: ['corridor'], equals: 'NG-GH' } },
      { regulatoryAmount: { gte: '123456789.0000001' } },
      { metadata: { path: ['riskScore'], gt: 59 } },
      { metadata: { path: ['riskScore'], lte: 79 } },
    ],
  });
  assert.throws(() => reportFilters({ maxAmount: '1e6' }), /decimal/);
});

test('CSV streams 50,000 rows in stable bounded pages and neutralizes spreadsheet formulas', async () => {
  let remaining = 50000;
  let lastId;
  const time = new Date('2026-11-20T00:00:00Z');
  const delegate = {
    async findMany({ take, where, orderBy }) {
      assert.ok(take <= 500);
      assert.deepEqual(orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
      if (lastId) assert.deepEqual(where.AND[1].OR[1], { createdAt: time, id: { lt: lastId } });
      return Array.from({ length: Math.min(take, remaining) }, () => ({
        id: (lastId = String(remaining--).padStart(5, '0')),
        amount: '5.0000001', asset: 'XLM', destination: '=1+1',
        createdAt: time, updatedAt: time,
      }));
    },
  };
  let count = 0;
  for await (const line of csvReport(transactionRows(delegate, {}))) {
    if (count === 0) assert.match(line, /riskScore,riskTier/);
    else assert.match(line, /^\d+,.*,5\.0000001,XLM,.*,'=1\+1,/);
    count++;
  }
  assert.equal(count, 50001);
});
