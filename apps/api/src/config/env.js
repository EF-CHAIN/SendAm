require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

module.exports = {
  port: process.env.PORT || 3002,
  env,
  isProduction: env === 'production',
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/sendam',
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
  // Request rate limiting. The store is Mongo-backed so counters are shared
  // across instances. `api*` caps REST traffic per IP; `bot*` caps inbound
  // WhatsApp messages per sender.
  rateLimit: {
    apiWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MIN || 15) * 60 * 1000,
    apiMax: Number(process.env.RATE_LIMIT_MAX || 100),
    botWindowMs: Number(process.env.BOT_RATE_WINDOW_SEC || 60) * 1000,
    botMax: Number(process.env.BOT_RATE_MAX || 20),
  },
  stellar: {
    network: process.env.STELLAR_NETWORK || 'testnet',
    horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  },
  // Defaults target Lisk Sepolia testnet (chain ID 4202). The official RPC
  // is rate-limited; https://lisk-sepolia.drpc.org is a documented
  // alternative if it gets hit hard during development.
  lisk: {
    chainId: Number(process.env.LISK_CHAIN_ID || 4202),
    rpcUrl: process.env.LISK_RPC_URL || 'https://rpc.sepolia-api.lisk.com',
    explorerUrl: process.env.LISK_EXPLORER_URL || 'https://sepolia-blockscout.lisk.com',
  },
  features: {
    // The unauthenticated REST wallet API (/api/wallet/*) treats the phone
    // number in the request body as identity, so anyone can read another
    // user's balance or move their funds. The real product surface is
    // WhatsApp (signature-verified), so this is OFF in production unless
    // explicitly enabled, and ON elsewhere for local testing.
    walletRestApi: process.env.ENABLE_WALLET_REST_API
      ? process.env.ENABLE_WALLET_REST_API === 'true'
      : env !== 'production',
  },
  // Private relayer that would sponsor Lisk gas so sending feels free, the
  // way Stellar's flat fee already does. The relayer itself (a funded gas
  // wallet + signing logic) is not part of this repo — see ARCHITECTURE.md.
  // Both vars are optional: unset means "no paymaster configured", and the
  // client degrades gracefully rather than erroring.
  paymaster: {
    serviceUrl: process.env.PAYMASTER_SERVICE_URL,
    apiKey: process.env.PAYMASTER_API_KEY,
  },
  // NGN display rate. Provider is swappable on purpose — whether SendAm
  // should show the official CBN rate or a parallel-market rate is a
  // product decision, not resolved by this config (see MAINTAINER.md).
  fx: {
    provider: process.env.FX_PROVIDER || 'exchangerate_api',
    apiKey: process.env.FX_API_KEY,
  },
  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    // No default here on purpose: an unset ANTHROPIC_MODEL falls back to the
    // most capable model rather than silently degrading to a cheap one a
    // misconfigured deploy never opted into. .env.example ships
    // ANTHROPIC_MODEL=claude-haiku-4-5 as the recommended, cost-appropriate
    // choice for this workload — that's an explicit choice an operator
    // makes, not an implicit default.
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    // Off by default. The regex command parser handles the common case for
    // free; this only ever runs as a fallback for messages it can't confidently
    // classify, and only when explicitly turned on.
    enabled: process.env.ENABLE_AI_INTENT_DECODER === 'true',
  },
};
