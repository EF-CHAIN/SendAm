/**
 * Shared helpers for provider contract / sandbox tests.
 * - Hermetic tests never require secrets.
 * - Credentialed tests skip cleanly when env vars are missing.
 * - Logs must not print secrets or PII.
 */

const REQUIRED_FOR_CREDENTIALED = {
  smileId: ["SMILE_ID_API_KEY", "SMILE_ID_PARTNER_ID"],
  pricing: ["EXCHANGE_RATE_API_KEY"],
  // Meta/Stellar contract checks can run hermetically; optional live keys:
  meta: ["WHATSAPP_APP_SECRET"],
  stellar: [], // public Horizon/testnet — no secret required for read-only
};

/**
 * Returns true when every listed env var is non-empty.
 * @param {string[]} keys
 */
function hasEnv(keys) {
  return keys.every((k) => {
    const v = process.env[k];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/**
 * Skip the current test when credentialed env is missing.
 * Use at the start of credentialed tests so PR CI stays green without secrets.
 * @param {keyof typeof REQUIRED_FOR_CREDENTIALED} provider
 * @param {{ skip: (msg?: string) => void }} t  node:test context
 */
function skipUnlessCredentials(provider, t) {
  const keys = REQUIRED_FOR_CREDENTIALED[provider] || [];
  if (!hasEnv(keys)) {
    const missingKeys = keys.filter((k) => !process.env[k] || !process.env[k].trim()).join(", ") || "(none)";
    if (process.env.REQUIRE_CONTRACT_SECRETS === "true" || process.env.REQUIRE_CONTRACT_SECRETS === "1") {
      throw new Error(`Scheduled provider contract test failed: missing required environment variables for ${provider}: ${missingKeys}`);
    }
    t.skip(
      `Skipping ${provider} credentialed contract test — missing env: ${missingKeys}`,
    );
    return true;
  }
  return false;
}

/**
 * Redact secrets and obvious PII from strings before logging/assert messages.
 * @param {string} input
 * @returns {string}
 */
function redact(input) {
  if (typeof input !== "string") return String(input);
  return input
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|secret|token|password)[=:]\s*["']?[^"'\s&]+/gi, "$1=[REDACTED]")
    .replace(/\b\d{10,15}\b/g, "[PHONE_REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]");
}

/**
 * Safe JSON stringify that redacts common secret field names.
 * @param {unknown} value
 */
function safeJson(value) {
  try {
    return redact(
      JSON.stringify(value, (key, val) => {
        if (
          typeof key === "string" &&
          /secret|token|password|apiKey|api_key|authorization/i.test(key)
        ) {
          return "[REDACTED]";
        }
        return val;
      }),
    );
  } catch {
    return "[unserializable]";
  }
}

module.exports = {
  REQUIRED_FOR_CREDENTIALED,
  hasEnv,
  skipUnlessCredentials,
  redact,
  safeJson,
};
