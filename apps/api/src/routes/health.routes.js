const { Router } = require('express');
const prisma = require('../common/prisma');
const { pingRedis } = require('../queues/queue.service');
const { CURRENT_VERSION, getKmsProvider } = require('../services/crypto.service');
const { buildRegistry, checkDependency, CRITICALITY, STATUS } = require('../observability/dependencies');

const router = Router();

router.get('/health/deep', async (_req, res, next) => {
  const checks = buildRegistry({ prisma, pingRedis }).filter(({ name }) => (
    ['postgres', 'redis', 'stellar_horizon'].includes(name)
  ));
  checks.push({
    name: 'kms',
    criticality: CRITICALITY.CRITICAL,
    check: async () => {
      const key = await getKmsProvider().generateDataKey({ keyVersion: CURRENT_VERSION });
      if (key?.plaintextKey?.byteLength !== 32 || !key.encryptedDataKey) {
        throw new Error('KMS did not return a usable envelope key');
      }
    },
  });

  try {
    const results = await Promise.all(checks.map((check) => checkDependency(check)));
    const unavailable = results.some(({ status }) => status === STATUS.UNHEALTHY);
    const components = Object.fromEntries(results.map(({ name, status }) => [name, status]));
    res.set('Cache-Control', 'no-store');
    res.status(unavailable ? 503 : 200).json({ status: unavailable ? 'degraded' : 'ok', components });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
