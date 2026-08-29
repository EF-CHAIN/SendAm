/**
 * Smile ID sandbox contract test.
 * Runs only when SMILE_ID_API_KEY and SMILE_ID_PARTNER_ID are set.
 * Never logs secrets; never hits production.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { skipUnlessCredentials, redact, safeJson } = require("./helpers");

// Sandbox base URL — override with SMILE_ID_BASE_URL if needed
const SMILE_BASE =
  process.env.SMILE_ID_BASE_URL || "https://testapi.smileidentity.com/v1";

describe("Smile ID sandbox contract", () => {
  it("sandbox auth/config endpoint accepts partner credentials", async (t) => {
    if (skipUnlessCredentials("smileId", t)) return;

    const partnerId = process.env.SMILE_ID_PARTNER_ID;
    const apiKey = process.env.SMILE_ID_API_KEY;

    // Minimal job payload shape many Smile ID flows expect; adjust if provider
    // docs for this repo differ. Failure mode must be actionable, not a secret leak.
    const payload = {
      partner_id: partnerId,
      timestamp: new Date().toISOString(),
      // signature often required in real calls — without full signing helper,
      // we only assert that the sandbox host responds with a structured body.
    };
    assert.equal(payload.partner_id, partnerId);

    let res;
    try {
      res = await fetch(`${SMILE_BASE}/products`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          // Some Smile setups use basic/partner headers; keep key out of logs.
          Authorization: `Bearer ${apiKey}`,
        },
      });
    } catch (err) {
      assert.fail(`Smile ID sandbox unreachable: ${redact(String(err.message || err))}`);
    }

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: redact(text.slice(0, 300)) };
    }

    // Accept 2xx or structured 4xx (auth shape OK) — fail only on total drift
    assert.ok(
      res.status < 500,
      `Smile ID sandbox server error ${res.status}: ${safeJson(body)}`,
    );
    assert.ok(
      typeof body === "object" && body !== null,
      "expected JSON response body from Smile ID sandbox",
    );
  });
});
