/**
 * Stellar sandbox / Horizon contract checks (read-only).
 * Uses public testnet Horizon — no secrets, no funds moved.
 * Skips automatically if Horizon is unreachable (offline CI).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { redact } = require("./helpers");

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: redact(text.slice(0, 200)) };
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

describe("Stellar Horizon testnet contract (read-only)", () => {
  it("root endpoint returns Horizon catalog fields", async (t) => {
    let result;
    try {
      result = await fetchJson(HORIZON_TESTNET);
    } catch (err) {
      t.skip(`Horizon unreachable: ${redact(String(err.message || err))}`);
      return;
    }

    assert.equal(result.ok, true, `Horizon status ${result.status}`);
    assert.ok(
      result.body._links || result.body.horizon_version || result.body.network_passphrase,
      "expected Horizon root document shape",
    );
  });

  it("ledgers list responds with embedded records array", async (t) => {
    let result;
    try {
      result = await fetchJson(`${HORIZON_TESTNET}/ledgers?limit=1&order=desc`);
    } catch (err) {
      t.skip(`Horizon unreachable: ${redact(String(err.message || err))}`);
      return;
    }

    assert.equal(result.ok, true);
    const records = result.body?._embedded?.records;
    assert.ok(Array.isArray(records), "expected _embedded.records array");
    if (records.length > 0) {
      assert.ok(records[0].sequence != null || records[0].hash);
    }
  });
});
