/**
 * Prisma seed — demo data for local dev / admin dashboard.
 *
 * Run:  npx prisma db seed
 *       (or)  node prisma/seed.js
 *
 * Idempotent: every User is upserted on phoneNumber; Wallets are upserted on
 * (userId, chain); Transactions and KycProfiles are only created when the
 * parent user was just inserted so that re-runs don't duplicate child rows.
 *
 * Keys / hashes are clearly fake ("G…DEMO…" Stellar-style public keys and
 * "encrypted:demo:" prefixed secrets). No real funds, no real keys.
 */

'use strict';

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Demo user definitions
// ---------------------------------------------------------------------------

const USERS = [
  {
    phoneNumber: '+2348001110001',
    whatsappName: 'Alice Demo',
    kycTier: 2,
    riskScore: 10,
    wallet: {
      chain: 'stellar',
      publicKey: 'GDEMO1ALICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      encryptedSecretKey: 'encrypted:demo:alice:aabbccdd1122334455',
      funded: true,
      network: 'testnet',
    },
    kyc: {
      tier: 2,
      status: 'approved',
      country: 'NG',
      provider: 'smileid',
    },
    transactions: [
      {
        type: 'send',
        amount: '50.00',
        asset: 'USDC',
        fiatCurrency: 'NGN',
        fiatAmount: '85000',
        rail: 'stellar',
        routeType: 'onchain',
        destination: 'GDEMO2BOBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        recipientPhoneNumber: '+2348001110002',
        txHash: 'DEMOTXHASH0000000000000000000000000000000000000000000000001',
        status: 'success',
        metadata: { note: 'Demo: lunch money' },
      },
      {
        type: 'send',
        amount: '200.00',
        asset: 'USDC',
        fiatCurrency: 'NGN',
        fiatAmount: '340000',
        rail: 'stellar',
        routeType: 'onchain',
        destination: 'GDEMO3CAROLXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        recipientPhoneNumber: '+2348001110003',
        txHash: null,
        status: 'failed',
        metadata: { note: 'Demo: failed payment', errorCode: 'INSUFFICIENT_FUNDS' },
      },
      {
        type: 'receive',
        amount: '100.00',
        asset: 'USDC',
        fiatCurrency: 'NGN',
        fiatAmount: '170000',
        rail: 'stellar',
        routeType: 'onchain',
        destination: null,
        recipientPhoneNumber: null,
        txHash: 'DEMOTXHASH0000000000000000000000000000000000000000000000002',
        status: 'success',
        metadata: { note: 'Demo: received from Bob' },
      },
    ],
  },
  {
    phoneNumber: '+2348001110002',
    whatsappName: 'Bob Demo',
    kycTier: 1,
    riskScore: 0,
    wallet: {
      chain: 'stellar',
      publicKey: 'GDEMO2BOBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      encryptedSecretKey: 'encrypted:demo:bob:bbccddee2233445566',
      funded: true,
      network: 'testnet',
    },
    kyc: {
      tier: 1,
      status: 'approved',
      country: 'NG',
      provider: 'smileid',
    },
    transactions: [
      {
        type: 'send',
        amount: '30.00',
        asset: 'USDC',
        fiatCurrency: 'NGN',
        fiatAmount: '51000',
        rail: 'stellar',
        routeType: 'onchain',
        destination: 'GDEMO1ALICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        recipientPhoneNumber: '+2348001110001',
        txHash: 'DEMOTXHASH0000000000000000000000000000000000000000000000003',
        status: 'success',
        metadata: { note: 'Demo: repay Alice' },
      },
      {
        type: 'send',
        amount: '75.00',
        asset: 'USDC',
        fiatCurrency: 'NGN',
        fiatAmount: '127500',
        rail: 'stellar',
        routeType: 'onchain',
        destination: 'GDEMO3CAROLXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        recipientPhoneNumber: '+2348001110003',
        txHash: null,
        status: 'processing',
        metadata: { note: 'Demo: in-flight transfer' },
      },
    ],
  },
  {
    phoneNumber: '+2348001110003',
    whatsappName: 'Carol Demo',
    kycTier: 0,
    riskScore: 5,
    wallet: {
      chain: 'stellar',
      publicKey: 'GDEMO3CAROLXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      encryptedSecretKey: 'encrypted:demo:carol:ccddeeff3344556677',
      funded: false,
      network: 'testnet',
    },
    kyc: {
      tier: 0,
      status: 'not_started',
      country: null,
      provider: 'smileid',
    },
    transactions: [
      {
        type: 'receive',
        amount: '200.00',
        asset: 'USDC',
        fiatCurrency: 'NGN',
        fiatAmount: '340000',
        rail: 'stellar',
        routeType: 'onchain',
        destination: null,
        recipientPhoneNumber: null,
        txHash: null,
        status: 'processing',
        metadata: { note: 'Demo: pending receipt' },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seed logic
// ---------------------------------------------------------------------------

async function seed() {
  console.log('🌱  Seeding demo data …');

  for (const def of USERS) {
    // 1. Upsert the user ─────────────────────────────────────────────────────
    const { created, user } = await upsertUser(def);

    // 2. Upsert the wallet ───────────────────────────────────────────────────
    await upsertWallet(user.id, def.wallet);

    // 3. Seed child rows only on first insert (keeps second run a no-op) ─────
    if (created) {
      await seedTransactions(user.id, def.transactions);
      await seedKycProfile(user.id, def.kyc);
      console.log(`  ✔  Created  ${def.phoneNumber} (${def.whatsappName})`);
    } else {
      console.log(`  –  Skipped  ${def.phoneNumber} (already exists)`);
    }
  }

  console.log('✅  Seed complete.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a user by phoneNumber.
 * Returns { user, created } where `created` is true only when a new row was
 * inserted (Prisma upsert doesn't expose this directly, so we detect it by
 * comparing createdAt ≈ updatedAt within a 500 ms window).
 */
async function upsertUser(def) {
  const before = new Date();

  const user = await prisma.user.upsert({
    where: { phoneNumber: def.phoneNumber },
    update: {}, // intentionally empty — don't overwrite manual dev changes
    create: {
      phoneNumber: def.phoneNumber,
      whatsappName: def.whatsappName,
      kycTier: def.kycTier,
      riskScore: def.riskScore,
    },
  });

  const created = user.createdAt >= before;
  return { user, created };
}

/**
 * Upsert a wallet on the (userId, chain) unique constraint.
 */
async function upsertWallet(userId, w) {
  await prisma.wallet.upsert({
    where: { userId_chain: { userId, chain: w.chain } },
    update: {}, // don't overwrite — keep any real keys that dev has set
    create: {
      userId,
      chain: w.chain,
      publicKey: w.publicKey,
      encryptedSecretKey: w.encryptedSecretKey,
      funded: w.funded,
      network: w.network,
    },
  });
}

/**
 * Bulk-create transactions for a newly inserted user.
 */
async function seedTransactions(userId, txDefs) {
  for (const tx of txDefs) {
    await prisma.transaction.create({
      data: {
        userId,
        type: tx.type,
        amount: tx.amount,
        asset: tx.asset,
        fiatCurrency: tx.fiatCurrency ?? null,
        fiatAmount: tx.fiatAmount ?? null,
        rail: tx.rail,
        routeType: tx.routeType,
        destination: tx.destination ?? null,
        recipientPhoneNumber: tx.recipientPhoneNumber ?? null,
        txHash: tx.txHash ?? null,
        status: tx.status,
        metadata: tx.metadata ?? {},
      },
    });
  }
}

/**
 * Create a KYC profile for a newly inserted user.
 */
async function seedKycProfile(userId, kyc) {
  await prisma.kycProfile.create({
    data: {
      userId,
      tier: kyc.tier,
      status: kyc.status,
      country: kyc.country ?? null,
      provider: kyc.provider,
    },
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

seed()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
