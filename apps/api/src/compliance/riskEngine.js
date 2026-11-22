const crypto = require('crypto');
const config = require('../config/env');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');
const { classifyRiskScore, RISK_THRESHOLDS } = require('./kycDecision.service');

const HIGH_RISK_COUNTRIES = new Set([
  'KP', 'IR', 'SY', 'CU', 'SD', 'BY', 'RU', 'AF', 'MM', 'VE', 'YE', 'SO', 'SS', 'LY', 'CD', 'CF'
]);

const HIGH_RISK_ASN_PREFIXES = new Set([
  'AS16276', 'AS14061', 'AS16509', 'AS13335', 'AS15169', 'AS209242', 'AS9009', 'AS16509',
]);

const TOR_EXIT_NODE_IPS = new Set();
const TOR_EXIT_NODE_CACHE_TTL = 60 * 60 * 1000;
let torCacheTimestamp = 0;

const VPN_PROXY_DETECTION_SERVICES = [
  { name: 'ipapi', url: 'http://ip-api.com/json/' },
  { name: 'ipinfo', url: 'https://ipinfo.io/' },
];

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

async function fetchTorExitNodes() {
  const now = Date.now();
  if (now - torCacheTimestamp < TOR_EXIT_NODE_CACHE_TTL && TOR_EXIT_NODE_IPS.size > 0) {
    return TOR_EXIT_NODE_IPS;
  }
  try {
    const axios = require('axios');
    const response = await axios.get('https://check.torproject.org/torbulkexitlist', {
      timeout: 10000,
      responseType: 'text',
    });
    const ips = response.data.split('\n').filter(ip => ip && !ip.startsWith('#'));
    TOR_EXIT_NODE_IPS.clear();
    ips.forEach(ip => TOR_EXIT_NODE_IPS.add(ip.trim()));
    torCacheTimestamp = now;
    logger.info('tor_exit_nodes_refreshed', { count: TOR_EXIT_NODE_IPS.size });
  } catch (error) {
    logger.warn('tor_exit_nodes_fetch_failed', { message: error.message });
  }
  return TOR_EXIT_NODE_IPS;
}

function isTorExitNode(ip) {
  return TOR_EXIT_NODE_IPS.has(ip);
}

function calculateIPRiskScore(ipInfo) {
  let score = 0;
  const reasons = [];

  if (ipInfo.isTor) {
    score += 40;
    reasons.push('tor_exit_node');
  }

  if (ipInfo.isProxy || ipInfo.isVPN || ipInfo.isHosting) {
    score += 25;
    reasons.push('proxy_vpn_hosting');
  }

  if (ipInfo.country && HIGH_RISK_COUNTRIES.has(ipInfo.country.toUpperCase())) {
    score += 20;
    reasons.push('high_risk_country');
  }

  if (ipInfo.asn && HIGH_RISK_ASN_PREFIXES.has(ipInfo.asn.toUpperCase())) {
    score += 15;
    reasons.push('high_risk_asn');
  }

  if (ipInfo.isAnonymous) {
    score += 10;
    reasons.push('anonymous_ip');
  }

  if (ipInfo.threatLevel && ipInfo.threatLevel > 7) {
    score += Math.min(20, ipInfo.threatLevel * 2);
    reasons.push('high_threat_level');
  }

  return { score: Math.min(score, 100), reasons };
}

function calculateCountryMismatchScore(phoneCountry, ipCountry) {
  if (!phoneCountry || !ipCountry) return { score: 0, reason: 'insufficient_data' };
  const phoneCC = phoneCountry.toUpperCase();
  const ipCC = ipCountry.toUpperCase();
  if (phoneCC === ipCC) return { score: 0, reason: 'match' };
  if (phoneCC === 'NG' && ipCC !== 'NG') return { score: 15, reason: 'ng_phone_foreign_ip' };
  if (ipCC === 'NG' && phoneCC !== 'NG') return { score: 10, reason: 'foreign_phone_ng_ip' };
  return { score: 12, reason: 'country_mismatch' };
}

function calculateAccountAgeScore(createdAt) {
  if (!createdAt) return { score: 5, reason: 'unknown' };
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 1) return { score: 25, reason: 'account_age_lt_1_day' };
  if (ageDays < 7) return { score: 15, reason: 'account_age_lt_1_week' };
  if (ageDays < 30) return { score: 8, reason: 'account_age_lt_1_month' };
  if (ageDays < 90) return { score: 3, reason: 'account_age_lt_3_months' };
  return { score: 0, reason: 'established_account' };
}

async function calculateVelocityScore(userId, windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const recentTxns = await prisma.transaction.findMany({
    where: {
      userId,
      createdAt: { gte: since },
      status: { in: ['success', 'processing', 'pending'] },
    },
    select: { amount: true, asset: true, createdAt: true, type: true },
  });

  const sendCount = recentTxns.filter(t => t.type === 'send').length;
  const totalAmount = recentTxns.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const uniqueDestinations = new Set(recentTxns.map(t => t.destination).filter(Boolean)).size;

  let score = 0;
  const reasons = [];

  if (sendCount > 20) { score += 20; reasons.push('high_frequency_gt_20'); }
  else if (sendCount > 10) { score += 10; reasons.push('high_frequency_gt_10'); }
  else if (sendCount > 5) { score += 5; reasons.push('moderate_frequency'); }

  if (totalAmount > 1000000) { score += 15; reasons.push('high_volume_gt_1m'); }
  else if (totalAmount > 100000) { score += 8; reasons.push('high_volume_gt_100k'); }

  if (uniqueDestinations > 10) { score += 10; reasons.push('many_destinations'); }
  else if (uniqueDestinations > 5) { score += 5; reasons.push('multiple_destinations'); }

  return { score: Math.min(score, 40), reasons };
}

function calculateDeviceFingerprintScore(deviceInfo, userId) {
  if (!deviceInfo) return { score: 5, reason: 'no_device_info' };

  let score = 0;
  const reasons = [];

  if (deviceInfo.isNewDevice) {
    score += 15;
    reasons.push('new_device');
  }

  if (deviceInfo.isEmulator) {
    score += 30;
    reasons.push('emulator_detected');
  }

  if (deviceInfo.isRooted || deviceInfo.isJailbroken) {
    score += 25;
    reasons.push('rooted_jailbroken');
  }

  if (deviceInfo.hardwareId && deviceInfo.hardwareId.length < 20) {
    score += 10;
    reasons.push('short_hardware_id');
  }

  if (deviceInfo.osVersion && deviceInfo.osVersion.includes('beta')) {
    score += 5;
    reasons.push('beta_os');
  }

  if (deviceInfo.appVersion && !deviceInfo.appVersion.match(/^\d+\.\d+\.\d+$/)) {
    score += 5;
    reasons.push('non_standard_app_version');
  }

  return { score: Math.min(score, 50), reasons };
}

async function enrichIPInfo(ip) {
  const cached = await prisma.ipReputationCache.findUnique({ where: { ip } });
  if (cached && Date.now() - new Date(cached.updatedAt).getTime() < 24 * 60 * 60 * 1000) {
    return cached.data;
  }

  let data = { ip };
  try {
    const axios = require('axios');
    const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,region,city,isp,org,as,proxy,hosting,query`, {
      timeout: 5000,
    });
    if (response.data.status === 'success') {
      const d = response.data;
      data = {
        ip,
        country: d.countryCode,
        region: d.region,
        city: d.city,
        isp: d.isp,
        org: d.org,
        asn: d.as,
        isProxy: d.proxy,
        isHosting: d.hosting,
        isAnonymous: d.proxy || d.hosting,
      };
    }
  } catch (_error) {
    data = { ip, error: 'lookup_failed' };
  }

  await prisma.ipReputationCache.upsert({
    where: { ip },
    update: { data, updatedAt: new Date() },
    create: { ip, data },
  });

  return data;
}

async function extractRiskFeatures({ userId, phoneNumber, ip, deviceInfo, destinationCountry, recipientPhoneNumber, amount, asset, routeType }) {
  await fetchTorExitNodes();

  const phoneCountry = phoneNumber?.startsWith('+234') ? 'NG' : phoneNumber?.startsWith('+') ? phoneNumber.slice(1, 3) : 'NG';

  const ipInfo = await enrichIPInfo(ip);
  ipInfo.isTor = isTorExitNode(ip);

  const ipRisk = calculateIPRiskScore(ipInfo);
  const countryMismatch = calculateCountryMismatchScore(phoneCountry, ipInfo.country);
  const accountAge = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } })
    .then(u => calculateAccountAgeScore(u?.createdAt));
  const velocity = await calculateVelocityScore(userId);
  const deviceFingerprint = calculateDeviceFingerprintScore(deviceInfo, userId);

  const features = {
    ipRisk: { ...ipRisk, details: ipInfo },
    countryMismatch,
    accountAge,
    velocity,
    deviceFingerprint,
    transaction: { amount, asset, routeType, destinationCountry },
    timestamp: new Date().toISOString(),
  };

  return features;
}

function computeRiskScore(features) {
  const weights = {
    ipRisk: 0.30,
    countryMismatch: 0.15,
    accountAge: 0.10,
    velocity: 0.25,
    deviceFingerprint: 0.20,
  };

  const weightedScore =
    features.ipRisk.score * weights.ipRisk +
    features.countryMismatch.score * weights.countryMismatch +
    features.accountAge.score * weights.accountAge +
    features.velocity.score * weights.velocity +
    features.deviceFingerprint.score * weights.deviceFingerprint;

  const allReasons = [
    ...features.ipRisk.reasons.map(r => `ip:${r}`),
    ...features.countryMismatch.reason ? [`country:${features.countryMismatch.reason}`] : [],
    ...features.accountAge.reason ? [`age:${features.accountAge.reason}`] : [],
    ...features.velocity.reasons.map(r => `velocity:${r}`),
    ...features.deviceFingerprint.reasons.map(r => `device:${r}`),
  ];

  return {
    score: Math.min(Math.round(weightedScore), 100),
    riskClass: classifyRiskScore(weightedScore),
    factors: features,
    reasons: allReasons,
  };
}

async function evaluateTransactionRisk(context) {
  const features = await extractRiskFeatures(context);
  const assessment = computeRiskScore(features);

  if (assessment.score > RISK_THRESHOLDS.CRITICAL_MIN) {
    await prisma.riskAssessment.create({
      data: {
        userId: context.userId,
        score: assessment.score,
        riskClass: assessment.riskClass,
        factors: assessment.factors,
        reasons: assessment.reasons,
        action: 'blocked',
        metadata: context,
      },
    });
    return { ...assessment, action: 'blocked', requiresStepUp: false };
  }

  if (assessment.score >= RISK_THRESHOLDS.HIGH_MAX) {
    await prisma.riskAssessment.create({
      data: {
        userId: context.userId,
        score: assessment.score,
        riskClass: assessment.riskClass,
        factors: assessment.factors,
        reasons: assessment.reasons,
        action: 'step_up_required',
        metadata: context,
      },
    });
    return { ...assessment, action: 'step_up_required', requiresStepUp: true };
  }

  await prisma.riskAssessment.create({
    data: {
      userId: context.userId,
      score: assessment.score,
      riskClass: assessment.riskClass,
      factors: assessment.factors,
      reasons: assessment.reasons,
      action: 'approved',
      metadata: context,
    },
  });

  return { ...assessment, action: 'approved', requiresStepUp: false };
}

module.exports = {
  HIGH_RISK_COUNTRIES,
  HIGH_RISK_ASN_PREFIXES,
  fetchTorExitNodes,
  isTorExitNode,
  calculateIPRiskScore,
  calculateCountryMismatchScore,
  calculateAccountAgeScore,
  calculateVelocityScore,
  calculateDeviceFingerprintScore,
  enrichIPInfo,
  extractRiskFeatures,
  computeRiskScore,
  evaluateTransactionRisk,
  RISK_THRESHOLDS,
  classifyRiskScore,
};