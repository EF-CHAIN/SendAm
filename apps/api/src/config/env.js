require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

module.exports = {
  port: process.env.PORT || 3002,
  env,
  isProduction: env === 'production',
  databaseUrl: process.env.DATABASE_URL,
  messageTransport: process.env.MESSAGE_TRANSPORT || 'meta',
  encryptionKey: process.env.ENCRYPTION_KEY,
  // Comma-separated list of origins allowed to call the REST API. Empty means
  // "no allowlist configured" — see app.js for the dev/prod behaviour.
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  admin: {
    password: process.env.ADMIN_PASSWORD,
    jwtSecret: process.env.JWT_SECRET,
    sessionTtlHours: Number(process.env.ADMIN_SESSION_TTL_HOURS || 12),
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    // Meta App Secret, used to verify the X-Hub-Signature-256 header on
    // inbound webhook POSTs so forged events can't drive money movement.
    appSecret: process.env.WHATSAPP_APP_SECRET,
    callbackUrl: process.env.WHATSAPP_CALLBACK_URL,
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    graphApiVersion: process.env.META_GRAPH_API_VERSION,
  },
  // Per-user transfer guardrails. Amounts are in XLM. Defaults are sane for a
  // testnet MVP; tighten via env before handling real value.
  limits: {
    maxSendAmount: Number(process.env.MAX_SEND_AMOUNT || 1000),
    dailySendAmount: Number(process.env.DAILY_SEND_LIMIT || 5000),
    dailySendCount: Number(process.env.MAX_SENDS_PER_DAY || 50),
  },
  // Request rate limiting. The store is PostgreSQL-backed so counters are shared
  // across instances. `api*` caps REST traffic per IP; `bot*` caps inbound
  // WhatsApp messages per sender.
  rateLimit: {
    apiWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MIN || 15) * 60 * 1000,
    apiMax: Number(process.env.RATE_LIMIT_MAX || 100),
    botWindowMs: Number(process.env.BOT_RATE_WINDOW_SEC || 60) * 1000,
    botMax: Number(process.env.BOT_RATE_MAX || 20),
  },
  redis: {
    url: process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL,
  },
  worker: {
    concurrency: Number(process.env.WORKER_CONCURRENCY || 5),
    lockDurationMs: Number(process.env.WORKER_LOCK_DURATION_MS || 30000),
    shutdownTimeoutMs: Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || 30000),
    heartbeatIntervalMs: Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 60000),
  },
  storage: {
    r2Endpoint: process.env.CLOUDFLARE_R2_ENDPOINT,
    r2Bucket: process.env.CLOUDFLARE_R2_BUCKET,
    r2AccessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    r2SecretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  },
  stellar: {
    network: process.env.STELLAR_NETWORK || 'testnet',
    horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    // Circle's official Testnet USDC issuer, so multi-asset balance lookups
    // work out of the box in dev; override for mainnet or a custom issuer.
    usdcIssuer: process.env.STELLAR_USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    // Convenience flag: true when STELLAR_NETWORK is not 'testnet'. Used to
    // gate mainnet-only safety controls (e.g. blocking Friendbot access).
    isMainnet: (process.env.STELLAR_NETWORK || 'testnet') !== 'testnet',
  },
  pricing: {
    coinGeckoBaseUrl: process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3',
    coinGeckoApiKey: process.env.COINGECKO_API_KEY,
    exchangeRateApiKey: process.env.EXCHANGERATE_API_KEY,
  },
  compliance: {
    provider: process.env.KYC_PROVIDER || 'smileid',
    smileId: {
      partnerId: process.env.SMILE_ID_PARTNER_ID,
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
    pinPepper: process.env.PIN_PEPPER,
  },
  voice: {
    provider: process.env.VOICE_PROVIDER || 'deepgram',
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    whisperApiKey: process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY,
  },
  features: {
    // The unauthenticated REST wallet API (/api/wallet/*) treats the phone
    // number in the request body as identity, so anyone can read another
    // user's balance or move their funds. Same story for the compliance
    // endpoints that set state from a bare phone number with no ownership
    // check (POST /api/compliance/pin, POST /api/compliance/kyc/start) — see
    // middlewares/requireRestApiEnabled. The real product surface is
    // WhatsApp (signature-verified), so all of these are OFF in production
    // unless explicitly enabled, and ON elsewhere for local testing.
    walletRestApi: process.env.ENABLE_WALLET_REST_API
      ? process.env.ENABLE_WALLET_REST_API === 'true'
      : env !== 'production',

    // The chat simulator (/api/sim/*) is a dev/test harness with no auth.
    // It must never be reachable in a real deployment by accident, so it
    // follows the same kill-switch pattern: OFF in production unless
    // explicitly set, ON elsewhere for local testing.
    chatSim: process.env.ENABLE_CHAT_SIM
      ? process.env.ENABLE_CHAT_SIM === 'true'
      : env !== 'production',
  },
};
