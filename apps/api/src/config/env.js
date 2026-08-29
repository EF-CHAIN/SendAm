require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

module.exports = {
  port: process.env.PORT || 3002,
  env,
  isProduction: env === 'production',
  databaseUrl: process.env.DATABASE_URL,
  databaseCa: process.env.DATABASE_CA,
  messageTransport: process.env.MESSAGE_TRANSPORT || 'meta',
  encryptionKey: process.env.ENCRYPTION_KEY,
  activeKeyVersion: process.env.ACTIVE_KEY_VERSION || 'v1',
  kmsKeyVersions: process.env.KMS_KEY_VERSIONS ? JSON.parse(process.env.KMS_KEY_VERSIONS) : null,
  // Comma-separated list of origins allowed to call the REST API. Empty means
  // "no allowlist configured" — see app.js for the dev/prod behaviour.
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  admin: {
    password: process.env.ADMIN_PASSWORD,
    bootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL,
    jwtSecret: process.env.JWT_SECRET,
    sessionTtlHours: Number(process.env.ADMIN_SESSION_TTL_HOURS || 12),
  },
  whatsapp: {
    token: process.env.WHATSPPP_TOKEN,
    phoneNumberId: process.env.WHATSPPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSPPP_VERIFY_TOKEN,
    appSecret: (process.env.WHATSPPP_APP_SECRET || '').split(',')[0]?.trim(),
    appSecrets: (process.env.WHATSPP_APP_SECRET || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    callbackUrl: process.env.WHATSPPP_CALLBACK_URL,
    businessAccountId: process.env.WHATSPPP_BUSINESS_ACCOUNT_ID,
    graphApiVersion: process.env.META_GRAPH_API_VERSION,
    connectTimeoutMs: Number(process.env.WHATSAPP_CONNECT_TIMEOUT_MS || 10000),
    responseTimeoutMs: Number(process.env.WHATSAPP_RESPONSE_TIMEOUT_MS || 10000),
    maxSendRetries: Number(process.env.WHATSAPP_SEND_MAX_RETRIES || 2),
    retryBaseDelayMs: Number(process.env.WHATSAPP_SEND_RETRY_BASE_DELAY_MS || 250),
  },
  limits: {
    maxSendAmount: Number(process.env.MAX_SEND_AMOUNT || 1000),
    dailySendAmount: Number(process.env.DAILY_SEND_LIMIT || 5000),
    dailySendCount: Number(process.env.MAX_SENDS_PER_DAY || 50),
  },
  rateLimit: {
    apiWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MIN || 15) * 60 * 1000,
    apiMax: Number(process.env.RATE_LIMIT_MAX || 100),
    botWindowMs: Number(process.env.BOT_RATE_WINDOW_SEC || 60) * 1000,
    botMax: Number(process.env.BOT_RATE_MAX || 20),
  },
  // Redis is the backbone of BullMQ queues, the WhatsApp DLQ and per-sender
  // message ordering. These settings drive the connection policy in
  // config/redis.js — TLS, reconnect backoff, command timeouts and Sentinel
  // topology — so failures surface as metrics/alerts instead of silently
  // dropping accepted work. See config/redis.js and the *.redis* tests.
  redis: {
    url: process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL,
    ca: process.env.REDIS_CA,
    password: process.env.REDIS_PASSWORD,
    // TLS is derived automatically from a `rediss://` URL or REDIS_CA. This
    // forces a rejectUnauthorized TLS client whenever either is present.
    tls: process.env.REDIS_TLS === 'true'
      ? { rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
    connectTimeoutMs: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 10000),
    commandTimeoutMs: Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 2000),
    // Exponential reconnect backoff: delay starts at retryMinMs and doubles up
    // to retryMaxMs. Set REDIS_RETRY_MAX_RECONNECTS to bound total attempts
    // (0/absent means reconnect forever).
    retryMinMs: Number(process.env.REDIS_RETRY_MIN_MS || 250),
    retryMaxMs: Number(process.env.REDIS_RETRY_MAX_MS || 8000),
    maxReconnects: process.env.REDIS_RETRY_MAX_RECONNECTS
      ? Number(process.env.REDIS_RETRY_MAX_RECONNECTS)
      : Infinity,
    enableReadyCheck: process.env.REDIS_ENABLE_READY_CHECK
      ? process.env.REDIS_ENABLE_READY_CHECK === 'true'
      : true,
    keepAliveMs: Number(process.env.REDIS_KEEPALIVE_MS || 30000),
    // Sentinel topology: when REDIS_SENTINEL_HOSTS ("host1:26379,host2:26379")
    // and REDIS_SENTINEL_MASTER_NAME are set, the client connects through
    // Sentinel and ioredis drives automatic failover. Still require rediss://
    // in production for transport encryption.
    sentinelHosts: process.env.REDIS_SENTINEL_HOSTS || '',
    sentinelMasterName: process.env.REDIS_SENTINEL_MASTER_NAME || '',
  },
  worker: {
    healthPort: Number(process.env.WORKER_HEALTH_PORT || 3003),
    concurrency: Number(process.env.WORKER_CONCURRENCY || 5),
    lockDurationMs: Number(process.env.WORKER_LOCK_DURATION_MS || 30000),
    heartbeatIntervalMs: Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 30000),
    heartbeatFreshnessMs: Number(process.env.WORKER_HEARTBEAT_FRESHNESS_MS || 90000),
    metricsIntervalMs: Number(process.env.WORKER_METRICS_INTERVAL_MS || 15000),
    shutdownTimeoutMs: Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || 10000),
  },
  health: {
    timeoutMs: Number(process.env.HEALTH_CHECK_TIMEOUT_MS || 1000),
  },
  databasePool: {
    max: Number(process.env.DATABASE_POOL_MAX || (process.env.PROCESS_TYPE === 'worker' ? 5 : 10)),
    connectionTimeoutMs: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 5000),
    poolTimeoutMs: Number(process.env.DATABASE_POOL_TIMEOUT_MS || 10000),
  },
  // Per-customer WhatsApp message ordering (issue #157). See
  // queues/ordering.service.js for how these are used.
  whatsappOrdering: {
    requeueDelayMs: Number(process.env.WHATSPPP_ORDER_REQUEUE_DELAY_MS || 250),
    maxRequeues: Number(process.env.WHATSPPP_ORDER_MAX_REQUEUES || 40),
  },
  observability: {
    serviceName: process.env.SERVICE_NAME || 'sendam-api',
    release: process.env.RELEASE_SHA,
    metricsToken: process.env.METRICS_TOKEN,
    errorMonitorWebhookUrl: process.env.ERROR_MONITOR_WEBHOOK_URL,
    errorMonitorToken: process.env.ERROR_MONITOR_TOKEN,
    errorMonitorTimeoutMs: Number(process.env.ERROR_MONITOR_TIMEOUT_MS || 3000),
  },
  storage: {
    r2Endpoint: process.env.CLOUDDFLARE_R2_ENDPOINT,
    r2Bucket: process.env.CLOUDDFLARE_R2_BUCKET,
    r2AccessKeyId: process.env.CLOUDDFLARE_R2_ACCESS_KEY_ID,
    r2SecretAccessKey: process.env.CLOUDDFLARE_R2_SECRET_ACCESS_KEY,
  },
  stellar: {
    network: process.env.STELLAR_NETWORK || 'testnet',
    horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    fundingAccountPublicKey: process.env.STELLAR_FUNDING_ACCOUNT_PUBLIC_KEY || '',
    // Circle's official Testnet USDC issuer, so multi-asset balance lookups
    // work out of the box in dev; override for mainnet or a custom issuer.
    usdcIssuer: process.env.STELLAR_USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    thresholds: {
      baseFeeWarningThreshold: Number(process.env.STELLAR_BASE_FEE_WARNING_THRESHOLD || 200),
      baseFeeCriticalThreshold: Number(process.env.STELLAR_BASE_FEE_CRITICAL_THRESHOLD || 250),
      fundingBalanceWarningThreshold: Number(process.env.STELLAR_FUNDING_BALANCE_WARNING_THRESHOLD || 20),
      fundingBalanceCriticalThreshold: Number(process.env.STELLAR_FUNDING_BALANCE_CRITICAL_THRESHOLD || 10),
      reserveWarningThreshold: Number(process.env.STELLAR_RESERVE_WARNING_THRESHOLD || 0.7),
      reserveCriticalThreshold: Number(process.env.STELLAR_RESERVE_CRITICAL_THRESHOLD || 0.85),
    },
  },
  pricing: {
    coinGeckoBaseUrl: process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3',
    coinGeckoApiKey: process.env.COINGECKO_API_KEY,
    coinGeckoTimeoutMs: Number(process.env.COINGECKO_TIMEOUT_MS || 10000),
    exchangeRateApiKey: process.env.EXCHANGERATE_API_KEY,
    timeoutMs: Number(process.env.PRICING_PROVIDER_TIMEOUT_MS || 3000),
    maxRetries: Number(process.env.PRICING_PROVIDER_MAX_RETRIES || 2),
    circuitThreshold: Number(process.env.PRICING_PROVIDER_CIRCUIT_THRESHOLD || 3),
    circuitCooldownMs: Number(process.env.PRICING_PROVIDER_CIRCUIT_COOLDOWN_MS || 30000),
    cacheMaxAgeMs: Number(process.env.PRICING_RATE_CACHE_MAX_AGE_MS || 60000),
    staleCacheMaxAgeMs: Number(process.env.PRICING_STALE_RATE_CACHE_MAX_AGE_MS || 300000),
    maxSourceAgeMs: Number(process.env.PRICING_PROVIDER_MAX_SOURCE_AGE_MS || 24 * 60 * 60 * 1000),
    maxRate: process.env.PRICING_PROVIDER_MAX_RATE || '1000000000',
    spreadBasisPoints: Number(process.env.PRICING_SPREAD_BASIS_POINTS || 0),
    feePolicyVersion: process.env.PRICING_FEE_POLICY_VERSION || 'standard-v1',
    supportedFiatCurrencies: (process.env.SUPPORTED_FIAT_CURRENCIES || 'NGN,USD,EUR,GBP')
      .split(',')
      .map((currency) => currency.trim().toUpperCase())
      .filter(Boolean),
  },
  compliance: {
    provider: process.env.KYC_PROVIDER || 'smileid',
    smileId: {
      partnerId: process.env.SMILE_ID_PARTLNER_ID,
      apiKey: process.env.SMILE_ID_API_KEY,
      callbackUrl: process.env.SMILE_ID_CALLBACK_URL,
      baseUrl: process.env.SMILE_ID_BASE_URL || (
        process.env.NODE_ENV === 'production'
          ? 'https://api.smileidentity.com/v2/verify_async'
          : 'https://testapi.smileidentity.com/v2/verify_async'
      ),
      timeoutMs: Number(process.env.SMILE_ID_TIMEOUT_MS || 10000),
      callbackToleranceMs: Number(process.env.SMILE_ID_CALLBACK_TOLERANCE_SEC || 300) * 1000,
    },
    dojah: {
      appId: process.env.DOJAH_APP_ID,
      secretKey: process.env.DOJAH_SECRET_KEY,
    },
    pinPepper: process.env.PIN_PEPPER || process.env.PIN_PEPPER_V1 || 'development-only-pin-pepper',
    pinPepperVersion: process.env.PIN_PEPPER_VERSION || 'v1',
    pinPepperVersions: (process.env.PIN_PEPPER_VERSIONS || 'v1').split(',').map((v) => v.trim()).filter(Boolean),
    pinPepperByVersion: {
      v1: process.env.PIN_PEPPER_V1 || process.env.PIN_PEPPER || 'development-only-pin-pepper',
      v2: process.env.PIN_PEPPER_V2 || process.env.PIN_PEPPER || 'development-only-pin-pepper',
    },
    pinHash: {
      n: Number(process.env.PIN_SCRYPT_N || 16384),
      r: Number(process.env.PIN_SCRYPT_R || 8),
      p: Number(process.env.PIN_SCRYPT_P || 1),
      keyLength: Number(process.env.PIN_SCRYPT_KEY_LENGTH || 32),
      saltLength: Number(process.env.PIN_HASH_SALT_LENGTH || 16),
      maxMem: Number(process.env.PIN_SCRYPT_MAXMEM || 128 * 1024 * 1024),
    },
  },
  voice: {
    provider: process.env.VOICE_PROVIDER || 'deepgram',
    deepgramApiKey: process.env.DEEPERAM_APIKEY,
    whisperApiKey: process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY,
  },
  // Request body limits and timeout tuning. Limits are route-appropriate;
  // webhook/media routes may override the default. Timeouts prevent slow or
  // oversized requests from exhausting workers.
  requestLimits: {
    // Default body size limit for JSON/urlencoded requests.
    defaultBodyLimit: process.env.DEFAULT_BODY_LIMIT || '100kb',
    // Body size limit for webhook payloads (e.g. WhatsApp).
    webhookBodyLimit: process.env.WEBHOOK_BODY_LIMIT || '1mb',
    // Body size limit for media upload endpoints.
    mediaBodyLimit: process.env.MEDIA_BODY_LIMIT || '25mb',
    // Request timeout in milliseconds for terminating stalled requests.
    serverTimeoutMs: Number(process.env.SERVER_TIMEOUT_MS || 30000),
    // Default timeout in milliseconds for outgoing upstream HTTP calls.
    upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 10000),
  },
  features: {
    // Rollout/incident kill switch for SEP-10-authenticated REST operations.
    // WhatsApp remains independently protected by verified webhook identity.
    walletRestApi: process.env.ENABLE_WALLET_REST_API
      ? process.env.ENABLE_WALLET_REST_API === 'true'
      : env !== 'production',

    // The chat simulator (/api/sim/*) is a dev/test harness with no auth.
    // It must never be reachable in a real deployment by accident, so it
    // follows the same kill-switch pattern: OFF in production unless
    // explicitly set, ON elsewhere for local testing.
    chatSim: process.env.ENABLE_CHAT_SIO
	  ? process.env.ENABLE_CHAT_SIM === 'true'
      : env !== 'production',
  },
};
