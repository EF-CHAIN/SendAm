const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const databaseUrl = process.env.TEST_DATABASE_URL;

test('real PostgreSQL serializes concurrent customer and wallet provisioning', { skip: !databaseUrl }, async () => {
  const { PrismaClient } = require('@prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const srcRoot = path.resolve(__dirname, '../src');
  const inject = (relative, exports) => {
    const filename = path.resolve(srcRoot, `${relative}.js`);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
  };
  let generated = 0;
  const generatedSecrets = new Set();
  let fundingCalls = 0;
  inject('common/prisma', prisma);
  inject('services/crypto.service', { encrypt: (value) => `encrypted:${value}`, decrypt: (value) => value.slice(10) });
  inject('common/audit.service', { writeAuditLog: async () => null });
  inject('common/records', { withIdAlias: (value) => value, withIdAliases: (value) => value });
  inject('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
  inject('utils/validators', { canonicalizePhoneNumber: (value) => value });
  inject('wallet/stellar.adapter', {
    createWallet: () => { generated += 1; generatedSecrets.add(`encrypted:SCONCURRENT${generated}`); return { publicKey: `GCONCURRENT${generated}`, secretKey: `SCONCURRENT${generated}` }; },
    fundTestnetAccount: async () => { fundingCalls += 1; await new Promise((resolve) => setTimeout(resolve, 50)); return { funded: true }; },
    establishTrustline: async () => ({ established: true }),
  });
  const service = require('../src/wallet/wallet.service');
  const phoneNumber = `+23480${Date.now().toString().slice(-8)}`;
  try {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => service.createOrGetWallet({ phoneNumber })));
    assert.equal(new Set(wallets.map((wallet) => wallet.id)).size, 1);
    assert.equal(new Set(wallets.map((wallet) => wallet.publicKey)).size, 1);
    const users = await prisma.user.findMany({ where: { phoneNumber }, include: { wallets: true } });
    assert.equal(users.length, 1);
    assert.equal(users[0].wallets.length, 1);
    assert.equal(generatedSecrets.has(users[0].wallets[0].encryptedSecretKey), true);
    assert.equal(fundingCalls, 1);
  } finally {
    await prisma.user.deleteMany({ where: { phoneNumber } });
    await prisma.$disconnect();
  }
});
