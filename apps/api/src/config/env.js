require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

module.exports = {
  port: process.env.PORT || 3002,
  env,
  isProduction: env === 'production',
  databaseUrl: process.env.DATABASE_URL,
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
  },
  // Private relayer that would sponsor transaction fees (Stellar fee-bump /
  // sponsored reserves) so sending feels free. The relayer itself (a funded
  // sponsor wallet + signing logic) is not part of this repo. Both vars are
  // optional: unset means "no paymaster configured", and the client degrades
  // gracefully rather than erroring. Not yet wired into the live send flow —
  // see paymaster.service.js.
  paymaster: {
    serviceUrl: process.env.PAYMASTER_SERVICE_URL,
    // HMAC shared secret for the X-Sendam-Signature calling contract.
    secret: process.env.PAYMASTER_SERVICE_SECRET,
    // Deprecated: legacy bearer token, superseded by PAYMASTER_SERVICE_SECRET.
    apiKey: process.env.PAYMASTER_API_KEY,
  },
  // Privately-operated service clients (see services/serviceClient.js for
  // the shared HMAC calling contract). Each is DOUBLY gated: the ENABLE_*
  // flag must be "true" AND the URL + secret must be set — anything less
  // means the client is disabled and its feature degrades gracefully. All
  // default off; the public repo runs fully standalone without them.
  ai: {
    enabled: process.env.ENABLE_AI_INTENT === 'true',
    serviceUrl: process.env.AI_SERVICE_URL,
    secret: process.env.AI_SERVICE_SECRET,
  },
  policy: {
    enabled: process.env.ENABLE_POLICY_SERVICE === 'true',
    serviceUrl: process.env.POLICY_SERVICE_URL,
    secret: process.env.POLICY_SERVICE_SECRET,
  },
  ns: {
    enabled: process.env.ENABLE_NS_RESOLUTION === 'true',
    serviceUrl: process.env.NS_SERVICE_URL,
    secret: process.env.NS_SERVICE_SECRET,
    domain: process.env.NS_DOMAIN || 'sendam.app',
  },
  settlement: {
    enabled: process.env.ENABLE_SETTLEMENT === 'true',
    serviceUrl: process.env.SETTLEMENT_SERVICE_URL,
    secret: process.env.SETTLEMENT_SERVICE_SECRET,
  },
  // NGN display rate. Provider is swappable on purpose — whether SendAm
  // should show the official CBN rate or a parallel-market rate is a
  // product decision, not resolved by this config.
  fx: {
    provider: process.env.FX_PROVIDER || 'exchangerate_api',
    apiKey: process.env.FX_API_KEY,
  },
};
