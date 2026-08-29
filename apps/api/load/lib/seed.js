'use strict';

const crypto = require('node:crypto');

/**
 * Seeds and removes the synthetic accounts the money-movement scenarios need.
 *
 * `payment-confirmation` cannot measure anything meaningful against users who
 * have no wallet and no PIN — every request would short-circuit on validation
 * and the run would report the latency of an error path. Seeding writes
 * straight to Postgres rather than going through the REST wallet endpoints
 * because those provision real Stellar accounts through Friendbot, which is a
 * slow external call and not what we are trying to measure.
 *
 * Every row is tagged with a run-scoped phone-number prefix so cleanup can be
 * exact, and `cleanup` runs even when a scenario throws.
 */

/** Mirrors compliance/pin.service.js — the same HMAC the app verifies against. */
const hashPin = (pin, pepper) => crypto.createHmac('sha256', pepper).update(String(pin)).digest('hex');

const SEED_PIN = '1234';

/** Reserved-looking range, so seeded rows are obvious in a shared environment. */
const phoneFor = (prefix, index) => `+2348${prefix}${String(index).padStart(4, '0')}`;

class Seeder {
  /**
   * @param {object} options
   * @param {string} options.databaseUrl
   * @param {string} options.pinPepper must match the API's PIN_PEPPER
   */
  constructor({ databaseUrl, pinPepper }) {
    this.databaseUrl = databaseUrl;
    this.pinPepper = pinPepper;
    // A 4-digit run tag keeps concurrent runs from colliding and keeps the
    // generated numbers a plausible length.
    this.prefix = String(Math.floor(1000 + Math.random() * 9000));
    this.client = null;
    this.seeded = [];
  }

  get available() {
    return Boolean(this.databaseUrl);
  }

  async connect() {
    const { Client } = require('pg');
    this.client = new Client({ connectionString: this.databaseUrl });
    await this.client.connect();
  }

  /**
   * @returns {Promise<Array<{phoneNumber: string, pin: string}>>}
   */
  async seedUsers(count) {
    if (!this.client) await this.connect();
    const users = [];

    for (let i = 0; i < count; i += 1) {
      const phoneNumber = phoneFor(this.prefix, i);
      const userId = `load_${this.prefix}_${i}`;
      await this.client.query(
        `INSERT INTO "User" (id, "phoneNumber", "whatsappName", "kycTier", "riskScore", "pinHash", "pinSetAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT ("phoneNumber") DO NOTHING`,
        [userId, phoneNumber, 'Load Test', 2, 0, hashPin(SEED_PIN, this.pinPepper)],
      );
      // A funded wallet row: the send flow reads it, and seeding it directly
      // avoids a Friendbot round trip per virtual user.
      await this.client.query(
        `INSERT INTO "Wallet" (id, "userId", chain, "phoneNumber", "publicKey", "encryptedSecretKey", funded, network, "updatedAt")
         VALUES ($1, $2, 'stellar', $3, $4, $5, true, 'testnet', NOW())
         ON CONFLICT ("userId", chain) DO NOTHING`,
        [`loadw_${this.prefix}_${i}`, userId, phoneNumber, `G${'A'.repeat(55)}`, 'load-test-not-a-real-key'],
      );
      users.push({ phoneNumber, pin: SEED_PIN, userId });
      this.seeded.push(userId);
    }

    return users;
  }

  /**
   * Removes everything this run created. Cascades handle wallets and
   * transactions; ProcessedMessage rows are keyed by message id, not user, so
   * they are cleared by the run-scoped prefix the scenarios embed.
   */
  async cleanup() {
    if (!this.client) return;
    try {
      await this.client.query('DELETE FROM "User" WHERE id = ANY($1)', [this.seeded]);
      await this.client.query('DELETE FROM "ProcessedMessage" WHERE "messageId" LIKE $1', [`wamid.load-%${this.prefix}%`]);
    } finally {
      await this.client.end().catch(() => {});
      this.client = null;
    }
  }
}

module.exports = { Seeder, hashPin, SEED_PIN, phoneFor };
