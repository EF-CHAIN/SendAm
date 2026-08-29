// Central startup check. crypto.service.js and adminAuth.service.js already
// throw at require-time for their own secrets, but that only fires once
// those specific modules happen to load, and it stops at the first problem
// found — an operator fixing ENCRYPTION_KEY only to hit JWT_SECRET on the
// next boot is a bad debugging loop. This runs once, explicitly, before the
// app starts accepting connections, and reports every violation at once.
// Circle's Testnet USDC issuer — must never be used on mainnet.
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const hasTls = (url, protocol) => {
  try {
    const parsed = new URL(url);
    return protocol === 'postgres'
      ? ['require', 'verify-ca', 'verify-full'].includes(parsed.searchParams.get('sslmode'))
      : parsed.protocol === 'rediss:';
  } catch (_error) {
    return false;
  }
};

const validateEnv = (config) => {
  const problems = [];

  if (!config.encryptionKey || Buffer.from(config.encryptionKey, 'hex').length !== 32) {
    problems.push('ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate one with: openssl rand -hex 32');
  }

  if (!config.admin.jwtSecret || config.admin.jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32');
  }

  if (config.admin.password && !config.admin.bootstrapEmail) {
    problems.push('ADMIN_BOOTSTRAP_EMAIL must be set while ADMIN_PASSWORD legacy bootstrap is enabled.');
  }

  if (config.isProduction && !config.whatsapp.appSecret) {
    problems.push('WHATSAPP_APP_SECRET must be set in production — without it, inbound webhook signatures cannot be verified.');
  }

  if (config.isProduction) {
    if (!config.databaseUrl || !hasTls(config.databaseUrl, 'postgres')) {
      problems.push('DATABASE_URL must use PostgreSQL TLS (sslmode=require, verify-ca, or verify-full) in production.');
    }
    if (!config.redis?.url || !hasTls(config.redis.url, 'redis')) {
      problems.push('REDIS_URL or UPSTASH_REDIS_URL must use rediss:// TLS in production.');
    }
    if (!Number.isInteger(config.databasePool?.max) || config.databasePool.max < 1) {
      problems.push('DATABASE_POOL_MAX must be a positive integer in production.');
    }
    if (!Number.isFinite(config.databasePool?.connectionTimeoutMs) || config.databasePool.connectionTimeoutMs < 1) {
      problems.push('DATABASE_CONNECTION_TIMEOUT_MS must be positive in production.');
    }
    if (!Number.isFinite(config.databasePool?.poolTimeoutMs) || config.databasePool.poolTimeoutMs < 1) {
      problems.push('DATABASE_POOL_TIMEOUT_MS must be positive in production.');
    }
  }

  if (config.isProduction && config.messageTransport === 'meta') {
    const requiredWhatsApp = [
      ['WHATSAPP_TOKEN', config.whatsapp?.token],
      ['WHATSAPP_PHONE_NUMBER_ID', config.whatsapp?.phoneNumberId],
      ['WHATSAPP_VERIFY_TOKEN', config.whatsapp?.verifyToken],
      ['WHATSAPP_CALLBACK_URL', config.whatsapp?.callbackUrl],
      ['WHATSAPP_BUSINESS_ACCOUNT_ID', config.whatsapp?.businessAccountId],
      ['META_GRAPH_API_VERSION', config.whatsapp?.graphApiVersion],
    ];
    for (const [name, value] of requiredWhatsApp) {
      if (!value) problems.push(`${name} must be set for the production Meta WhatsApp webhook.`);
    }
    if (config.whatsapp?.callbackUrl && !config.whatsapp.callbackUrl.startsWith('https://')) {
      problems.push('WHATSAPP_CALLBACK_URL must use HTTPS in production.');
    }
    if (config.whatsapp?.verifyToken && config.whatsapp.verifyToken.length < 32) {
      problems.push('WHATSAPP_VERIFY_TOKEN must be at least 32 characters in production.');
    }
  }

  if (config.isProduction && !config.compliance?.pinPepper) {
    problems.push('PIN_PEPPER must be set in production for secure PIN hashing.');
  }

  if (config.isProduction) {
    if (!config.observability?.metricsToken || config.observability.metricsToken.length < 32) {
      problems.push('METRICS_TOKEN must be at least 32 characters in production.');
    }
    if (!config.observability?.errorMonitorWebhookUrl) {
      problems.push('ERROR_MONITOR_WEBHOOK_URL must be set in production.');
    } else if (!config.observability.errorMonitorWebhookUrl.startsWith('https://')) {
      problems.push('ERROR_MONITOR_WEBHOOK_URL must use HTTPS in production.');
    }
  }

  if (!['meta', 'sim'].includes(config.messageTransport)) {
    problems.push(`MESSAGE_TRANSPORT must be either 'meta' or 'sim' (got '${config.messageTransport}').`);
  }

  // Mainnet safety: the testnet USDC issuer must never be used on mainnet.
  // This prevents accidental misconfiguration that could cause funds to be
  // sent to or received from an uncontrolled testnet issuer.
  if (config.stellar && config.stellar.isMainnet) {
    if (config.stellar.usdcIssuer === TESTNET_USDC_ISSUER) {
      problems.push(
        'STELLAR_USDC_ISSUER on mainnet must not be the Testnet issuer. '
        + 'Set it to Circle\'s mainnet issuer: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      );
    }
  }

  if (config.features?.walletRestApi) {
    const auth = config.stellar?.auth || {};
    if (!auth.signingKey) problems.push('STELLAR_AUTH_SIGNING_KEY must be set when the wallet REST API is enabled.');
    if (!auth.homeDomain) problems.push('STELLAR_HOME_DOMAIN must be set when the wallet REST API is enabled.');
    if (!auth.webAuthDomain) problems.push('STELLAR_WEB_AUTH_DOMAIN must be set when the wallet REST API is enabled.');
    if (!Number.isFinite(auth.challengeTtlSeconds) || auth.challengeTtlSeconds < 30 || auth.challengeTtlSeconds > 900) {
      problems.push('STELLAR_AUTH_CHALLENGE_TTL_SECONDS must be between 30 and 900.');
    }
    if (!Number.isFinite(auth.sessionTtlMinutes) || auth.sessionTtlMinutes < 1 || auth.sessionTtlMinutes > 60) {
      problems.push('REST_SESSION_TTL_MINUTES must be between 1 and 60.');
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
};

const validateWorkerEnv = (config) => {
  const problems = [];
  if (!config.redis?.url) problems.push('REDIS_URL or UPSTASH_REDIS_URL must be set for the background worker.');
  if (!Number.isInteger(config.worker?.concurrency) || config.worker.concurrency < 1) {
    problems.push('WORKER_CONCURRENCY must be a positive integer.');
  }
  if (!Number.isFinite(config.worker?.lockDurationMs) || config.worker.lockDurationMs < 5000) {
    problems.push('WORKER_LOCK_DURATION_MS must be at least 5000.');
  }
  if (problems.length) throw new Error(`Invalid worker configuration:\n  - ${problems.join('\n  - ')}`);
};

module.exports = { validateEnv, validateWorkerEnv };
