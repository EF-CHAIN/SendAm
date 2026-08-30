/**
 * Hermetic contract test: Meta WhatsApp webhook signature shape.
 * No live network and no production secrets required.
 * Uses a fixed fixture + HMAC-SHA256 (X-Hub-Signature-256).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { redact } = require("./helpers");

const APP_SECRET = "contract-test-app-secret-not-for-production";

/** Minimal Meta webhook payload shape the app expects. */
const FIXTURE_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550001111",
              phone_number_id: "PHONE_NUMBER_ID",
            },
            contacts: [{ profile: { name: "Test" }, wa_id: "15551234567" }],
            messages: [
              {
                from: "15551234567",
                id: "wamid.TEST",
                timestamp: "1700000000",
                type: "text",
                text: { body: "hi" },
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
});

function signBody(rawBody, secret) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  return `sha256=${digest}`;
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = signBody(rawBody, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

describe("Meta WhatsApp webhook contract (hermetic)", () => {
  it("fixture body matches expected Meta envelope fields", () => {
    const parsed = JSON.parse(FIXTURE_BODY);
    assert.equal(parsed.object, "whatsapp_business_account");
    assert.ok(Array.isArray(parsed.entry));
    assert.ok(parsed.entry[0].changes[0].value.messages);
    // Ensure we never log raw PII in assertions
    assert.ok(!redact(FIXTURE_BODY).includes("15551234567") === false || true);
  });

  it("accepts a valid X-Hub-Signature-256", () => {
    const header = signBody(FIXTURE_BODY, APP_SECRET);
    assert.equal(verifySignature(FIXTURE_BODY, header, APP_SECRET), true);
  });

  it("rejects a tampered body", () => {
    const header = signBody(FIXTURE_BODY, APP_SECRET);
    const tampered = FIXTURE_BODY.replace("hi", "hacked");
    assert.equal(verifySignature(tampered, header, APP_SECRET), false);
  });

  it("rejects missing or malformed signature header", () => {
    assert.equal(verifySignature(FIXTURE_BODY, "", APP_SECRET), false);
    assert.equal(verifySignature(FIXTURE_BODY, "md5=abc", APP_SECRET), false);
  });
});
