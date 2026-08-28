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
  storage: {
    r2Endpoint: process.env.CLOUDFLARE_R2_ENDPOINT,
    r2Bucket: process.env.CLOUDFLARE_R2_BUCKET,
    r2AccessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    r2SecretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
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
    exchangeRateApiKey: process.env.EXCHANGERATE_API_KEY,
  },
  compliance: {
    provider: process.env.KYC_PROVIDER || 'smileid',
    smileId: {
      partnerId: process.env.SMILE_ID_PARTNER_ID,
      apiKey: process.env.SMILE_ID_API_KEY,
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
