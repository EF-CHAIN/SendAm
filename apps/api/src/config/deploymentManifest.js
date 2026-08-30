const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./env');

const MANIFEST_VERSION = '1.0';
const SUPPORTED_ENVIRONMENTS = ['development', 'staging', 'production'];

const collectManifestEnv = () => {
  const whitelist = [
    'NODE_ENV',
    'PORT',
    'DATABASE_URL',
    'CORS_ORIGINS',
    'ENCRYPTION_KEY',
    'JWT_SECRET',
    'ADMIN_BOOTSTRAP_EMAIL',
    'MESSAGE_TRANSPORT',
    'MAX_SEND_AMOUNT',
    'DAILY_SEND_LIMIT',
    'MAX_SENDS_PER_DAY',
    'RATE_LIMIT_WINDOW_MIN',
    'RATE_LIMIT_MAX',
    'REDIS_URL',
    'UPSTASH_REDIS_URL',
    'WORKER_CONCURRENCY',
    'WORKER_LOCK_DURATION_MS',
    'SERVICE_NAME',
    'RELEASE_SHA',
    'METRICS_TOKEN',
    'ERROR_MONITOR_WEBHOOK_URL',
    'ERROR_MONITOR_TOKEN',
    'STELLAR_NETWORK',
    'STELLAR_HORIZON_URL',
    'STELLAR_USDC_ISSUER',
    'STELLAR_AUTH_SIGNING_KEY',
    'STELLAR_HOME_DOMAIN',
    'STELLAR_WEB_AUTH_DOMAIN',
    'ENABLE_WALLET_REST_API',
    'ENABLE_CHAT_SIM',
    'COINGECKO_API_KEY',
    'EXCHANGERATE_API_KEY',
    'KYC_PROVIDER',
    'PIN_PEPPER',
    'POLICY_CURRENCY',
    'POLICY_VERSION',
    'VOICE_PROVIDER',
    'SMILE_ID_PARTNER_ID',
    'SMILE_ID_API_KEY',
    'SMILE_ID_CALLBACK_URL',
    'DOJAH_APP_ID',
    'DOJAH_SECRET_KEY',
  ];

  const values = {};
  for (const key of whitelist) {
    if (process.env[key] !== undefined) {
      values[key] = process.env[key];
    }
  }
  return values;
};

const computeConfigHash = (envValues) => {
  const normalized = JSON.stringify(envValues, Object.keys(envValues).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
};

const buildManifest = ({ environment, release, signedBy }) => {
  const env = environment || config.env;
  if (!SUPPORTED_ENVIRONMENTS.includes(env)) {
    throw new Error(`Unsupported environment: ${env}. Must be one of: ${SUPPORTED_ENVIRONMENTS.join(', ')}`);
  }

  const envValues = collectManifestEnv();
  const configHash = computeConfigHash(envValues);

  const manifest = {
    version: MANIFEST_VERSION,
    environment: env,
    release: release || process.env.RELEASE_SHA || 'local',
    generatedAt: new Date().toISOString(),
    configHash,
    config: envValues,
    approved: true,
    approvedBy: signedBy || process.env.USER || 'unknown',
    checksums: {
      sha256: configHash,
    },
  };

  return manifest;
};

const signManifest = (manifest, secret) => {
  if (!secret) {
    throw new Error('MANIFEST_SIGNING_SECRET must be set to sign deployment manifests.');
  }
  const payload = JSON.stringify(manifest);
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return {
    ...manifest,
    signature: {
      algorithm: 'hmac-sha256',
      value: signature,
      signedAt: new Date().toISOString(),
    },
  };
};

const verifyManifest = (signedManifest, secret) => {
  if (!signedManifest || !signedManifest.signature) {
    return { valid: false, reason: 'Manifest or signature missing.' };
  }
  if (!secret) {
    return { valid: false, reason: 'MANIFEST_SIGNING_SECRET is not configured.' };
  }

  const { algorithm, value, signedAt } = signedManifest.signature;
  if (algorithm !== 'hmac-sha256') {
    return { valid: false, reason: `Unsupported signature algorithm: ${algorithm}` };
  }

  const manifestCopy = { ...signedManifest };
  delete manifestCopy.signature;

  const payload = JSON.stringify(manifestCopy);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  if (expected !== value) {
    return { valid: false, reason: 'Signature verification failed. Manifest may have been tampered with.' };
  }

  const ageMs = Date.now() - new Date(signedAt).getTime();
  const maxAgeMs = 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    return { valid: false, reason: `Manifest signature is too old (${Math.round(ageMs / 3600000)}h). Re-sign and redeploy.` };
  }

  return { valid: true, signedAt, environment: signedManifest.environment, release: signedManifest.release };
};

const writeManifest = (signedManifest, outputPath) => {
  const target = outputPath || path.resolve(process.cwd(), 'deployment-manifest.json');
  fs.writeFileSync(target, JSON.stringify(signedManifest, null, 2));
  return target;
};

const readManifest = (manifestPath) => {
  const target = manifestPath || process.env.DEPLOYMENT_MANIFEST_PATH;
  if (!target) return null;
  if (!fs.existsSync(target)) return null;
  const content = fs.readFileSync(target, 'utf8');
  return JSON.parse(content);
};

const validateManifestAtStartup = () => {
  const manifestPath = process.env.DEPLOYMENT_MANIFEST_PATH;
  const signingSecret = process.env.DEPLOYMENT_MANIFEST_SECRET;

  if (!manifestPath) {
    if (config.isProduction) {
      throw new Error('DEPLOYMENT_MANIFEST_PATH must be set in production to verify the deployment manifest.');
    }
    return { skipped: true, reason: 'No manifest path configured (non-production).' };
  }

  const manifest = readManifest(manifestPath);
  if (!manifest) {
    throw new Error(`Deployment manifest not found at ${manifestPath}`);
  }

  if (!manifest.approved) {
    throw new Error(`Deployment manifest at ${manifestPath} is not marked as approved.`);
  }

  const verification = verifyManifest(manifest, signingSecret);
  if (!verification.valid) {
    throw new Error(`Deployment manifest verification failed: ${verification.reason}`);
  }

  return { skipped: false, valid: true, environment: verification.environment, release: verification.release };
};

module.exports = {
  MANIFEST_VERSION,
  SUPPORTED_ENVIRONMENTS,
  buildManifest,
  signManifest,
  verifyManifest,
  writeManifest,
  readManifest,
  validateManifestAtStartup,
  computeConfigHash,
  collectManifestEnv,
};
