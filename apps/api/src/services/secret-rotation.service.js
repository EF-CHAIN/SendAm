const crypto = require('crypto');
const config = require('../config/env');
const { writeAuditLog } = require('../common/audit.service');
const prisma = require('../common/prisma');
const logger = require('../utils/logger');

const SECRET_CATEGORIES = Object.freeze({
  ENCRYPTION_KEY: 'encryption_key',
  JWT_SECRET: 'jwt_secret',
  PIN_PEPPER: 'pin_pepper',
  WHATSAPP_APP_SECRET: 'whatsapp_app_secret',
  METRICS_TOKEN: 'metrics_token',
  ERROR_MONITOR_TOKEN: 'error_monitor_token',
  COINGECKO_API_KEY: 'coingecko_api_key',
  EXCHANGERATE_API_KEY: 'exchangerate_api_key',
  SMILE_ID_API_KEY: 'smile_id_api_key',
  DOJAH_SECRET_KEY: 'dojah_secret_key',
  DEEPGRAM_API_KEY: 'deepgram_api_key',
  WHISPER_API_KEY: 'whisper_api_key',
  STELLAR_AUTH_SIGNING_KEY: 'stellar_auth_signing_key',
});

const ROTATION_CADENCE_DAYS = Object.freeze({
  ENCRYPTION_KEY: 90,
  JWT_SECRET: 90,
  PIN_PEPPER: 180,
  WHATSAPP_APP_SECRET: 365,
  METRICS_TOKEN: 365,
  ERROR_MONITOR_TOKEN: 365,
  COINGECKO_API_KEY: 180,
  EXCHANGERATE_API_KEY: 180,
  SMILE_ID_API_KEY: 90,
  DOJAH_SECRET_KEY: 90,
  DEEPGRAM_API_KEY: 180,
  WHISPER_API_KEY: 180,
  STELLAR_AUTH_SIGNING_KEY: 365,
});

const ROTATION_OWNERS = Object.freeze({
  ENCRYPTION_KEY: 'security',
  JWT_SECRET: 'security',
  PIN_PEPPER: 'compliance',
  WHATSAPP_APP_SECRET: 'operations',
  METRICS_TOKEN: 'operations',
  ERROR_MONITOR_TOKEN: 'operations',
  COINGECKO_API_KEY: 'operations',
  EXCHANGERATE_API_KEY: 'operations',
  SMILE_ID_API_KEY: 'compliance',
  DOJAH_SECRET_KEY: 'compliance',
  DEEPGRAM_API_KEY: 'operations',
  WHISPER_API_KEY: 'operations',
  STELLAR_AUTH_SIGNING_KEY: 'security',
});

const generateSecretValue = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

const getSecretHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

const getRotationDueDate = (category, lastRotatedAt) => {
  const cadenceDays = ROTATION_CADENCE_DAYS[category] || 365;
  const last = lastRotatedAt ? new Date(lastRotatedAt) : new Date(0);
  return new Date(last.getTime() + cadenceDays * 24 * 60 * 60 * 1000);
};

const isRotationExpiringSoon = (dueDate, warningDays = 30) => {
  const now = new Date();
  const warningThreshold = new Date(now.getTime() + warningDays * 24 * 60 * 60 * 1000);
  return dueDate <= warningThreshold;
};

const evaluateRotationHealth = async () => {
  const now = new Date();
  const results = [];
  const alertWebhookUrl = config.observability?.errorMonitorWebhookUrl;
  const alertToken = config.observability?.errorMonitorToken;

  for (const [category, owner] of Object.entries(ROTATION_OWNERS)) {
    const dueDate = getRotationDueDate(category, null);
    const expiringSoon = isRotationExpiringSoon(dueDate, 30);
    const expired = dueDate < now;

    results.push({
      category,
      owner,
      dueDate: dueDate.toISOString(),
      status: expired ? 'expired' : expiringSoon ? 'expiring_soon' : 'ok',
      cadenceDays: ROTATION_CADENCE_DAYS[category] || 365,
    });

    if (expired || expiringSoon) {
      const alertPayload = {
        text: `[Secret Rotation] ${category} is ${expired ? 'EXPIRED' : 'expiring soon'}. Owner: ${owner}. Due: ${dueDate.toISOString()}`,
        level: expired ? 'critical' : 'warning',
        category,
        owner,
        dueDate: dueDate.toISOString(),
      };

      if (alertWebhookUrl) {
        try {
          const axios = require('axios');
          await axios.post(alertWebhookUrl, alertPayload, {
            headers: {
              'Content-Type': 'application/json',
              ...(alertToken ? { Authorization: `Bearer ${alertToken}` } : {}),
            },
            timeout: config.observability?.errorMonitorTimeoutMs || 3000,
          });
        } catch (error) {
          logger.warn(`Failed to send secret rotation alert for ${category}: ${error.message}`);
        }
      }
    }
  }

  await writeAuditLog({
    actorType: 'system',
    action: 'secret.rotation.health_check',
    entityType: 'SecretRotation',
    metadata: { evaluatedAt: now.toISOString(), results, alertWebhookConfigured: Boolean(alertWebhookUrl) },
  });

  return results;
};

const rotateSecret = async ({ category, newValue, rotatedBy }) => {
  if (!SECRET_CATEGORIES[category]) {
    throw Object.assign(new Error(`Unknown secret category: ${category}`), { statusCode: 400 });
  }

  const hash = getSecretHash(newValue);
  const now = new Date();

  await prisma.secretRotation.create({
    data: {
      category,
      hash,
      rotatedBy: rotatedBy || 'system',
      rotatedAt: now,
      expiresAt: getRotationDueDate(category, now),
    },
  });

  await writeAuditLog({
    actorType: 'administrator',
    actorId: rotatedBy || 'system',
    action: 'secret.rotation.completed',
    entityType: 'SecretRotation',
    metadata: { category, expiresAt: getRotationDueDate(category, now).toISOString() },
  });

  return { category, hash, rotatedAt: now.toISOString(), expiresAt: getRotationDueDate(category, now).toISOString() };
};

const getRotationStatus = async () => {
  const rotations = await prisma.secretRotation.findMany({
    orderBy: { rotatedAt: 'desc' },
    take: 100,
  });

  const health = await evaluateRotationHealth();

  return {
    rotations: rotations.map((r) => ({
      id: r.id,
      category: r.category,
      rotatedBy: r.rotatedBy,
      rotatedAt: r.rotatedAt,
      expiresAt: r.expiresAt,
      hash: r.hash,
    })),
    health,
  };
};

module.exports = {
  SECRET_CATEGORIES,
  ROTATION_CADENCE_DAYS,
  ROTATION_OWNERS,
  evaluateRotationHealth,
  rotateSecret,
  getRotationStatus,
  generateSecretValue,
  getSecretHash,
  getRotationDueDate,
  isRotationExpiringSoon,
};
