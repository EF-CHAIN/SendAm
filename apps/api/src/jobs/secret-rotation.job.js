const { evaluateRotationHealth, rotateSecret, generateSecretValue, SECRET_CATEGORIES } = require('../services/secret-rotation.service');
const logger = require('../utils/logger');

const JOB_NAME = 'secret-rotation-health-check';

const runRotationHealthCheck = async () => {
  try {
    const results = await evaluateRotationHealth();
    const critical = results.filter((r) => r.status === 'expired');
    const warning = results.filter((r) => r.status === 'expiring_soon');

    if (critical.length > 0) {
      logger.error('secret_rotation_critical', { expiring: critical.map((r) => r.category) });
    }

    if (warning.length > 0) {
      logger.warn('secret_rotation_warning', { expiring: warning.map((r) => r.category) });
    }

    return { checked: results.length, critical: critical.length, warning: warning.length, results };
  } catch (error) {
    logger.error('secret_rotation_job_failed', { error: error.message });
    throw error;
  }
};

const rotateCategorySecret = async ({ category, rotatedBy }) => {
  if (!SECRET_CATEGORIES[category]) {
    throw Object.assign(new Error(`Unknown secret category: ${category}`), { statusCode: 400 });
  }
  const newValue = generateSecretValue();
  const result = await rotateSecret({ category, newValue, rotatedBy });
  logger.info('secret_rotation_completed', { category, rotatedBy, expiresAt: result.expiresAt });
  return result;
};

module.exports = {
  JOB_NAME,
  runRotationHealthCheck,
  rotateCategorySecret,
};
