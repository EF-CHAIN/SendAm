'use strict';

// Dynamic transaction risk scoring from geo-IP, phone/IP country match,
// account age, velocity and device signals (#992).
//
// Score: each factor contributes points up to its own cap; the total is capped
// at 100. Additive (not a weighted average) so that several independent red
// flags together actually reach the action thresholds:
//   score > 80  -> stepped-up authentication required (PIN + OTP)
//   score > 95  -> transfer blocked
//
// Runs BEFORE the payment's DB transaction (it may make network calls) and
// complements — never replaces — compliance.service's policy checks.
//
// Signal gathering fails open per factor: an unavailable lookup contributes 0
// points and is recorded in `reasons`, so an outage of an enrichment source
// cannot block every payment. Limits, sanctions screening and the existing
// manual-review threshold in compliance.service remain fail-closed.

const net = require('net');
const axios = require('axios');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const prisma = require('../common/prisma');
const config = require('../config/env');
const logger = require('../utils/logger');
const { classifyRiskScore } = require('./kycDecision.service');

const STEP_UP_ABOVE = 80;
const BLOCK_ABOVE = 95;

const FACTOR_CAPS = Object.freeze({
  ipRisk: 60,
  countryMismatch: 15,
  accountAge: 25,
  velocity: 30,
  deviceFingerprint: 40,
});

const HIGH_RISK_COUNTRIES = new Set([
  'KP', 'IR', 'SY', 'CU', 'SD', 'BY', 'RU', 'AF', 'MM', 'VE', 'YE', 'SO', 'SS', 'LY', 'CD', 'CF',
]);

// Large hosting/cloud networks: consumer traffic rarely originates there.
const HIGH_RISK_ASNS = new Set(['AS16276', 'AS14061', 'AS16509', 'AS13335', 'AS15169', 'AS209242', 'AS9009']);

const NETWORK_TIMEOUT_MS = 3000;
const TOR_EXIT_LIST_URL = 'https://check.torproject.org/torbulkexitlist';
const TOR_REFRESH_MS = 60 * 60 * 1000;
const TOR_RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const IP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const defaultHttpGet = async (url, { responseType = 'json' } = {}) => {
  const response = await axios.get(url, { timeout: NETWORK_TIMEOUT_MS, responseType });
  return response.data;
};

// ---- Tor exit list (process-local cache, refreshed at most hourly) ---------

const torState = { ips: new Set(), fetchedAt: 0, failedAt: 0 };

const refreshTorExitNodes = async ({ httpGet = defaultHttpGet, now = Date.now() } = {}) => {
  if (now - torState.fetchedAt < TOR_REFRESH_MS) return torState.ips;
  if (now - torState.failedAt < TOR_RETRY_AFTER_FAILURE_MS) return torState.ips;
  try {
    const text = await httpGet(TOR_EXIT_LIST_URL, { responseType: 'text' });
    const ips = String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && net.isIP(line));
    torState.ips = new Set(ips);
    torState.fetchedAt = now;
    logger.info('tor_exit_nodes_refreshed', { count: torState.ips.size });
  } catch (error) {
    torState.failedAt = now;
    logger.warn('tor_exit_nodes_fetch_failed', { message: error.message });
  }
  return torState.ips;
};

const isTorExitNode = (ip) => torState.ips.has(ip);

const resetTorCache = () => {
  torState.ips = new Set();
  torState.fetchedAt = 0;
  torState.failedAt = 0;
};

// ---- IP enrichment -----------------------------------------------------------

const isPublicIp = (ip) => {
  const version = net.isIP(String(ip || ''));
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    return !(lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80'));
  }
  return false;
};

/**
 * Geo/ASN/proxy data for an IP. The external lookup is opt-in
 * (RISK_IP_LOOKUP_URL, a URL template containing `{ip}` that returns
 * ip-api.com-shaped JSON) because it sends the user's IP to a third party.
 * Results are cached for 24h in IpReputationCache.
 */
const enrichIPInfo = async (ip, { httpGet = defaultHttpGet, lookupUrl = config.compliance?.riskIpLookupUrl, now = Date.now() } = {}) => {
  const cached = await prisma.ipReputationCache.findUnique({ where: { ip } });
  if (cached && now - new Date(cached.updatedAt).getTime() < IP_CACHE_TTL_MS) {
    return { ...cached.data, ip };
  }
  if (!lookupUrl) return { ip, lookup: 'not_configured' };

  try {
    const d = await httpGet(lookupUrl.replace('{ip}', encodeURIComponent(ip)));
    if (d?.status && d.status !== 'success') return { ip, lookup: 'failed' };
    const data = {
      country: d?.countryCode || null,
      asn: d?.as || null,
      isProxy: Boolean(d?.proxy),
      isHosting: Boolean(d?.hosting),
    };
    await prisma.ipReputationCache.upsert({
      where: { ip },
      update: { data },
      create: { ip, data },
    });
    return { ...data, ip };
  } catch (error) {
    logger.warn('risk_ip_lookup_failed', { message: error.message });
    return { ip, lookup: 'failed' };
  }
};

// ---- factor scoring (pure) ---------------------------------------------------

const calculateIPRiskScore = (ipInfo) => {
  if (!ipInfo) return { score: 0, reasons: ['ip_not_provided'] };
  let score = 0;
  const reasons = [];
  if (ipInfo.isTor) { score += 40; reasons.push('tor_exit_node'); }
  if (ipInfo.isProxy || ipInfo.isVPN || ipInfo.isHosting) { score += 25; reasons.push('proxy_vpn_hosting'); }
  if (ipInfo.country && HIGH_RISK_COUNTRIES.has(String(ipInfo.country).toUpperCase())) {
    score += 20;
    reasons.push('high_risk_country');
  }
  // ip-api returns e.g. "AS16509 Amazon.com, Inc."
  const asn = ipInfo.asn ? String(ipInfo.asn).trim().split(/\s+/)[0].toUpperCase() : null;
  if (asn && HIGH_RISK_ASNS.has(asn)) { score += 15; reasons.push('high_risk_asn'); }
  if (ipInfo.threatLevel && ipInfo.threatLevel > 7) {
    score += Math.min(20, ipInfo.threatLevel * 2);
    reasons.push('high_threat_level');
  }
  return { score: Math.min(score, FACTOR_CAPS.ipRisk), reasons };
};

const phoneCountry = (phoneNumber) => {
  if (!phoneNumber) return null;
  const parsed = parsePhoneNumberFromString(String(phoneNumber).startsWith('+') ? String(phoneNumber) : `+${phoneNumber}`);
  return parsed?.country || null;
};

const calculateCountryMismatchScore = (phoneCC, ipCC) => {
  if (!phoneCC || !ipCC) return { score: 0, reasons: ['insufficient_data'] };
  const phone = String(phoneCC).toUpperCase();
  const ip = String(ipCC).toUpperCase();
  if (phone === ip) return { score: 0, reasons: ['match'] };
  if (phone === 'NG') return { score: 15, reasons: ['ng_phone_foreign_ip'] };
  if (ip === 'NG') return { score: 10, reasons: ['foreign_phone_ng_ip'] };
  return { score: 12, reasons: ['country_mismatch'] };
};

const calculateAccountAgeScore = (createdAt, now = Date.now()) => {
  if (!createdAt) return { score: 5, reasons: ['unknown'] };
  const ageDays = (now - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays < 1) return { score: 25, reasons: ['account_age_lt_1_day'] };
  if (ageDays < 7) return { score: 15, reasons: ['account_age_lt_1_week'] };
  if (ageDays < 30) return { score: 8, reasons: ['account_age_lt_1_month'] };
  if (ageDays < 90) return { score: 3, reasons: ['account_age_lt_3_months'] };
  return { score: 0, reasons: ['established_account'] };
};

const scoreVelocity = (recentSends) => {
  const sendCount = recentSends.length;
  const recipients = new Set(recentSends.map((t) => t.destination || t.recipientPhoneNumber).filter(Boolean)).size;
  let score = 0;
  const reasons = [];
  if (sendCount > 20) { score += 20; reasons.push('high_frequency_gt_20'); }
  else if (sendCount > 10) { score += 10; reasons.push('high_frequency_gt_10'); }
  else if (sendCount > 5) { score += 5; reasons.push('moderate_frequency'); }
  if (recipients > 10) { score += 10; reasons.push('many_recipients'); }
  else if (recipients > 5) { score += 5; reasons.push('multiple_recipients'); }
  return { score: Math.min(score, FACTOR_CAPS.velocity), reasons, sendCount, recipients };
};

const calculateVelocityScore = async (userId, { now = Date.now(), windowHours = 24 } = {}) => {
  const recentSends = await prisma.transaction.findMany({
    where: {
      userId,
      type: 'send',
      createdAt: { gte: new Date(now - windowHours * 60 * 60 * 1000) },
      status: { in: ['success', 'processing', 'pending'] },
    },
    select: { destination: true, recipientPhoneNumber: true },
  });
  return scoreVelocity(recentSends);
};

const calculateDeviceFingerprintScore = (deviceInfo) => {
  // WhatsApp traffic carries no device data; absence is not itself a signal.
  if (!deviceInfo) return { score: 0, reasons: ['not_provided'] };
  let score = 0;
  const reasons = [];
  if (deviceInfo.isNewDevice) { score += 15; reasons.push('new_device'); }
  if (deviceInfo.isEmulator) { score += 30; reasons.push('emulator_detected'); }
  if (deviceInfo.isRooted || deviceInfo.isJailbroken) { score += 25; reasons.push('rooted_jailbroken'); }
  if (deviceInfo.hardwareId && String(deviceInfo.hardwareId).length < 20) { score += 10; reasons.push('short_hardware_id'); }
  if (deviceInfo.osVersion && String(deviceInfo.osVersion).toLowerCase().includes('beta')) { score += 5; reasons.push('beta_os'); }
  if (deviceInfo.appVersion && !/^\d+\.\d+\.\d+$/.test(String(deviceInfo.appVersion))) { score += 5; reasons.push('non_standard_app_version'); }
  return { score: Math.min(score, FACTOR_CAPS.deviceFingerprint), reasons };
};

// ---- feature extraction ------------------------------------------------------

const safeFactor = async (name, fn) => {
  try {
    return await fn();
  } catch (error) {
    logger.warn('risk_factor_unavailable', { factor: name, message: error.message });
    return { score: 0, reasons: ['unavailable'] };
  }
};

const extractRiskFeatures = async (
  { userId, phoneNumber, ip, deviceInfo, destinationCountry, amount, asset, routeType },
  deps = {},
) => {
  const now = deps.now ?? Date.now();
  let ipInfo = null;
  if (ip && isPublicIp(ip)) {
    ipInfo = await safeFactor('ip_enrichment', async () => {
      await refreshTorExitNodes({ httpGet: deps.httpGet, now });
      const info = await enrichIPInfo(ip, { httpGet: deps.httpGet, lookupUrl: deps.lookupUrl, now });
      return { ...info, isTor: isTorExitNode(ip) };
    });
  }

  const ipRisk = calculateIPRiskScore(ipInfo);
  const countryMismatch = calculateCountryMismatchScore(phoneCountry(phoneNumber), ipInfo?.country);
  const accountAge = await safeFactor('account_age', async () => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
    return calculateAccountAgeScore(user?.createdAt, now);
  });
  const velocity = await safeFactor('velocity', () => calculateVelocityScore(userId, { now }));
  const deviceFingerprint = calculateDeviceFingerprintScore(deviceInfo);

  return {
    ipRisk: { ...ipRisk, country: ipInfo?.country || null },
    countryMismatch,
    accountAge,
    velocity,
    deviceFingerprint,
    transaction: { amount, asset, routeType, destinationCountry },
  };
};

const FACTOR_KEYS = Object.keys(FACTOR_CAPS);

const computeRiskScore = (features) => {
  let total = 0;
  const reasons = [];
  for (const key of FACTOR_KEYS) {
    const factor = features[key] || { score: 0, reasons: [] };
    total += Math.min(Math.max(0, Number(factor.score) || 0), FACTOR_CAPS[key]);
    for (const reason of factor.reasons || []) reasons.push(`${key}:${reason}`);
  }
  const score = Math.min(100, Math.round(total));
  return { score, riskClass: classifyRiskScore(score), factors: features, reasons };
};

const decideAction = (score) => {
  if (score > BLOCK_ABOVE) return 'blocked';
  if (score > STEP_UP_ABOVE) return 'step_up_required';
  return 'approved';
};

/**
 * Scores a payment attempt and records the assessment. Never throws for
 * scoring/persistence problems; use assertRiskAllowsPayment to act on it.
 */
const evaluateTransactionRisk = async (context, deps = {}) => {
  const features = await extractRiskFeatures(context, deps);
  const assessment = computeRiskScore(features);
  const action = decideAction(assessment.score);

  try {
    await prisma.riskAssessment.create({
      data: {
        userId: context.userId,
        score: assessment.score,
        riskClass: assessment.riskClass,
        factors: assessment.factors,
        reasons: assessment.reasons,
        action,
        // No phone numbers here: the factors carry what an investigator needs.
        metadata: { ip: context.ip || null, routeType: context.routeType || null, destinationCountry: context.destinationCountry || null },
      },
    });
  } catch (error) {
    logger.warn('risk_assessment_persist_failed', { message: error.message });
  }

  if (action !== 'approved') {
    logger.warn('transaction_risk_flagged', { userId: context.userId, score: assessment.score, action, reasons: assessment.reasons });
  }

  return { ...assessment, action, requiresStepUp: action === 'step_up_required' };
};

const assertRiskAllowsPayment = (assessment, { stepUpVerified = false } = {}) => {
  if (!assessment) return;
  if (assessment.action === 'blocked') {
    throw Object.assign(new Error('This transfer was blocked by our risk checks. Please contact support.'), {
      statusCode: 403,
      code: 'CRITICAL_RISK_BLOCK',
      riskScore: assessment.score,
    });
  }
  if (assessment.action === 'step_up_required' && !stepUpVerified) {
    throw Object.assign(new Error('Additional verification (PIN and one-time code) is required to complete this transfer.'), {
      statusCode: 403,
      code: 'STEP_UP_REQUIRED',
      riskScore: assessment.score,
    });
  }
};

module.exports = {
  STEP_UP_ABOVE,
  BLOCK_ABOVE,
  FACTOR_CAPS,
  HIGH_RISK_COUNTRIES,
  HIGH_RISK_ASNS,
  refreshTorExitNodes,
  isTorExitNode,
  resetTorCache,
  isPublicIp,
  enrichIPInfo,
  phoneCountry,
  calculateIPRiskScore,
  calculateCountryMismatchScore,
  calculateAccountAgeScore,
  scoreVelocity,
  calculateVelocityScore,
  calculateDeviceFingerprintScore,
  extractRiskFeatures,
  computeRiskScore,
  decideAction,
  evaluateTransactionRisk,
  assertRiskAllowsPayment,
  classifyRiskScore,
};
