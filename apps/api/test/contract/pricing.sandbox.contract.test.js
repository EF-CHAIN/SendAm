/**
 * Pricing provider contract test (ExchangeRate / similar).
 * Credentialed when EXCHANGE_RATE_API_KEY is set; otherwise skips.
 * Read-only quote shape only — no payments.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { skipUnlessCredentials, redact, safeJson } = require("./helpers");

const EXCHANGE_RATE_BASE =
  process.env.EXCHANGE_RATE_BASE_URL || "https://v6.exchangerate-api.com/v6";

describe("Pricing provider sandbox contract", () => {
  it("returns a numeric FX rate for a common pair", async (t) => {
    if (skipUnlessCredentials("pricing", t)) return;

    const key = process.env.EXCHANGE_RATE_API_KEY;
    const url = `${EXCHANGE_RATE_BASE}/${encodeURIComponent(key)}/pair/USD/NGN`;

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      assert.fail(`Pricing provider unreachable: ${redact(String(err.message || err))}`);
    }

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      assert.fail(`Non-JSON pricing response: ${redact(text.slice(0, 200))}`);
    }

    assert.ok(res.ok, `pricing HTTP ${res.status}: ${safeJson(body)}`);
    // Common exchangerate-api fields
    const rate =
      body.conversion_rate ?? body.rate ?? body.result?.rate ?? body.rates?.NGN;
    assert.equal(typeof rate, "number", `expected numeric rate, got ${safeJson(body)}`);
    assert.ok(rate > 0, "rate must be positive");
  });
});
