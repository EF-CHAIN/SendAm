'use strict';

const { test, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');

const mockPrisma = {
  user: { findUnique: async () => null },
  transaction: { findMany: async () => [] },
  ipReputationCache: { findUnique: async () => null, upsert: async () => {} },
  riskAssessment: { create: async () => {} },
};

require.cache[require.resolve('../src/common/prisma')] = { exports: mockPrisma };

const risk = require('../src/compliance/riskEngine');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const TOR_IP = '185.220.101.1';

// Fake network: Tor list contains TOR_IP; the IP lookup returns `ipData`.
const fakeHttp = (ipData) => {
  const calls = [];
  const httpGet = async (url) => {
    calls.push(url);
    if (url.includes('torbulkexitlist')) return `# exit list\n${TOR_IP}\n203.0.113.9\n`;
    return ipData;
  };
  return { httpGet, calls };
};

let persisted;

beforeEach(() => {
  risk.resetTorCache();
  persisted = [];
  mockPrisma.user.findUnique = async () => ({ createdAt: new Date(NOW - 400 * DAY) });
  mockPrisma.transaction.findMany = async () => [];
  mockPrisma.ipReputationCache.findUnique = async () => null;
  mockPrisma.ipReputationCache.upsert = async () => {};
  mockPrisma.riskAssessment.create = async ({ data }) => { persisted.push(data); return data; };
});

describe('factor scoring', () => {
  test('IP risk: Tor + hosting + high-risk country + hosting ASN, capped', () => {
    const r = risk.calculateIPRiskScore({ isTor: true, isHosting: true, country: 'ir', asn: 'AS16509 Amazon.com, Inc.' });
    assert.equal(r.score, risk.FACTOR_CAPS.ipRisk);
    assert.ok(r.reasons.includes('tor_exit_node'));
    assert.ok(r.reasons.includes('high_risk_asn'), 'ASN parsed from ip-api "AS123 Name" format');
  });

  test('IP risk: no IP means no points', () => {
    assert.deepEqual(risk.calculateIPRiskScore(null), { score: 0, reasons: ['ip_not_provided'] });
  });

  test('phone country is resolved to ISO-3166 from E.164 or wa_id', () => {
    assert.equal(risk.phoneCountry('+2348012345678'), 'NG');
    assert.equal(risk.phoneCountry('442071838750'), 'GB');
    assert.equal(risk.phoneCountry(null), null);
  });

  test('country mismatch compares ISO codes', () => {
    assert.equal(risk.calculateCountryMismatchScore('NG', 'NG').score, 0);
    assert.equal(risk.calculateCountryMismatchScore('NG', 'GB').score, 15);
    assert.equal(risk.calculateCountryMismatchScore('GB', 'NG').score, 10);
    assert.equal(risk.calculateCountryMismatchScore('NG', null).score, 0);
  });

  test('account age buckets', () => {
    assert.equal(risk.calculateAccountAgeScore(new Date(NOW - 2 * 60 * 60 * 1000), NOW).score, 25);
    assert.equal(risk.calculateAccountAgeScore(new Date(NOW - 3 * DAY), NOW).score, 15);
    assert.equal(risk.calculateAccountAgeScore(new Date(NOW - 400 * DAY), NOW).score, 0);
  });

  test('velocity counts sends and distinct recipients', () => {
    const sends = Array.from({ length: 25 }, (_, i) => ({ recipientPhoneNumber: `+23480000000${i % 12}` }));
    const r = risk.scoreVelocity(sends);
    assert.equal(r.sendCount, 25);
    assert.equal(r.recipients, 12);
    assert.equal(r.score, 30);
  });

  test('device: absence is not a signal; emulator + rooted is', () => {
    assert.equal(risk.calculateDeviceFingerprintScore(undefined).score, 0);
    assert.equal(risk.calculateDeviceFingerprintScore({ isEmulator: true, isRooted: true }).score, risk.FACTOR_CAPS.deviceFingerprint);
  });

  test('private and loopback IPs are not looked up', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '::1', 'fd00::1', 'nonsense']) {
      assert.equal(risk.isPublicIp(ip), false, ip);
    }
    assert.equal(risk.isPublicIp('8.8.8.8'), true);
  });
});

describe('score and action thresholds (#992)', () => {
  test('total is additive and capped at 100', () => {
    const f = (score) => ({ score, reasons: [] });
    const r = risk.computeRiskScore({ ipRisk: f(60), countryMismatch: f(15), accountAge: f(25), velocity: f(30), deviceFingerprint: f(40) });
    assert.equal(r.score, 100);
  });

  test('> 80 requires step-up, > 95 blocks, boundaries inclusive of approval', () => {
    assert.equal(risk.decideAction(80), 'approved');
    assert.equal(risk.decideAction(81), 'step_up_required');
    assert.equal(risk.decideAction(95), 'step_up_required');
    assert.equal(risk.decideAction(96), 'blocked');
  });

  test('a WhatsApp payment from an established user is approved and recorded', async () => {
    const r = await risk.evaluateTransactionRisk({ userId: 'u1', phoneNumber: '+2348012345678' }, { now: NOW });
    assert.equal(r.action, 'approved');
    assert.equal(r.score, 0);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].action, 'approved');
    assert.equal(JSON.stringify(persisted[0]).includes('+2348012345678'), false, 'no phone numbers persisted');
  });

  test('Tor + hosting from a new account with a NG phone abroad requires step-up', async () => {
    mockPrisma.user.findUnique = async () => ({ createdAt: new Date(NOW - 3 * DAY) });
    const { httpGet } = fakeHttp({ status: 'success', countryCode: 'DE', as: 'AS24940 Hetzner', hosting: true });
    const r = await risk.evaluateTransactionRisk(
      { userId: 'u1', phoneNumber: '+2348012345678', ip: TOR_IP },
      { now: NOW, httpGet, lookupUrl: 'https://ip.example/json/{ip}' },
    );
    // ip 40+25=65 (cap 60) + mismatch 15 + age 15 = 90
    assert.equal(r.score, 90);
    assert.equal(r.action, 'step_up_required');
    assert.throws(() => risk.assertRiskAllowsPayment(r), (e) => e.code === 'STEP_UP_REQUIRED' && e.statusCode === 403);
    assert.doesNotThrow(() => risk.assertRiskAllowsPayment(r, { stepUpVerified: true }));
  });

  test('stacked red flags block the transfer even after step-up', async () => {
    mockPrisma.user.findUnique = async () => ({ createdAt: new Date(NOW - 60 * 60 * 1000) });
    const { httpGet } = fakeHttp({ status: 'success', countryCode: 'RU', as: 'AS9009 M247', proxy: true });
    const r = await risk.evaluateTransactionRisk(
      { userId: 'u1', phoneNumber: '+2348012345678', ip: TOR_IP, deviceInfo: { isEmulator: true } },
      { now: NOW, httpGet, lookupUrl: 'https://ip.example/json/{ip}' },
    );
    assert.ok(r.score > 95, `score ${r.score}`);
    assert.equal(r.action, 'blocked');
    assert.throws(() => risk.assertRiskAllowsPayment(r, { stepUpVerified: true }), (e) => e.code === 'CRITICAL_RISK_BLOCK');
  });
});

describe('resilience', () => {
  test('without RISK_IP_LOOKUP_URL the user IP is never sent to a third party', async () => {
    const { httpGet, calls } = fakeHttp({});
    await risk.evaluateTransactionRisk({ userId: 'u1', ip: '8.8.8.8' }, { now: NOW, httpGet, lookupUrl: null });
    assert.deepEqual(calls.filter((u) => !u.includes('torbulkexitlist')), []);
  });

  test('a failing Tor list fetch is not retried on every payment', async () => {
    let torCalls = 0;
    const httpGet = async () => { torCalls += 1; throw new Error('ETIMEDOUT'); };
    await risk.evaluateTransactionRisk({ userId: 'u1', ip: '8.8.8.8' }, { now: NOW, httpGet });
    await risk.evaluateTransactionRisk({ userId: 'u1', ip: '8.8.8.8' }, { now: NOW + 60 * 1000, httpGet });
    assert.equal(torCalls, 1);
  });

  test('database errors in factors or persistence do not throw', async () => {
    mockPrisma.user.findUnique = async () => { throw new Error('db down'); };
    mockPrisma.transaction.findMany = async () => { throw new Error('db down'); };
    mockPrisma.riskAssessment.create = async () => { throw new Error('db down'); };
    const r = await risk.evaluateTransactionRisk({ userId: 'u1' }, { now: NOW });
    assert.equal(r.action, 'approved');
    assert.ok(r.reasons.includes('accountAge:unavailable'));
    assert.ok(r.reasons.includes('velocity:unavailable'));
  });

  test('cached IP reputation is reused without a lookup', async () => {
    mockPrisma.ipReputationCache.findUnique = async () => ({ data: { country: 'NG' }, updatedAt: new Date(NOW - 60 * 1000) });
    const { httpGet, calls } = fakeHttp({});
    const r = await risk.evaluateTransactionRisk(
      { userId: 'u1', phoneNumber: '+2348012345678', ip: '102.89.1.1' },
      { now: NOW, httpGet, lookupUrl: 'https://ip.example/json/{ip}' },
    );
    assert.deepEqual(calls.filter((u) => u.includes('ip.example')), []);
    assert.ok(r.reasons.includes('countryMismatch:match'));
  });
});
