const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRecipientResolver } = require('../src/whatsapp/recipientResolver');

const STELLAR_ACCOUNT = `G${'A'.repeat(55)}`;
const CONTACT_ACCOUNT = `G${'B'.repeat(55)}`;
const WALLET_ACCOUNT = `G${'C'.repeat(55)}`;
const WALLET_ACCOUNT_2 = `G${'D'.repeat(55)}`;
const user = { id: 'u_1' };
const VALID_PHONE = '+2348012345678';
const VALID_PHONE_2 = '+2348012345679';

const prismaWithAliases = (aliases) => ({
  alias: {
    findUnique: async ({ where }) => aliases[where.userId_alias.alias] ?? null,
  },
});

const walletServiceMock = (wallets = {}) => ({
  createOrGetWallet: async ({ phoneNumber }) => {
    if (!wallets[phoneNumber]) {
      wallets[phoneNumber] = { publicKey: WALLET_ACCOUNT, id: `w_${phoneNumber}` };
    }
    return wallets[phoneNumber];
  },
});

test('saved contacts win for bare names', async () => {
  const resolve = createRecipientResolver({
    prisma: prismaWithAliases({ mama: { target: CONTACT_ACCOUNT, targetType: 'stellar' } }),
  });
  const result = await resolve(user, 'Mama ');
  assert.deepEqual(result, { destination: CONTACT_ACCOUNT, label: 'mama' });
});

test('unknown bare names pass through raw', async () => {
  const resolve = createRecipientResolver({ prisma: prismaWithAliases({}) });
  const result = await resolve(user, 'ada');
  assert.deepEqual(result, { destination: 'ada', label: 'ada' });
});

test('raw addresses pass through untouched (validation happens downstream)', async () => {
  const resolve = createRecipientResolver({ prisma: prismaWithAliases({}) });
  const result = await resolve(user, STELLAR_ACCOUNT);
  assert.deepEqual(result, { destination: STELLAR_ACCOUNT, label: STELLAR_ACCOUNT });
});

test('phone number for new user creates wallet and returns its address', async () => {
  const resolve = createRecipientResolver({
    prisma: prismaWithAliases({}),
    walletService: walletServiceMock(),
  });
  const result = await resolve(user, VALID_PHONE);
  assert.deepEqual(result, { destination: WALLET_ACCOUNT, label: VALID_PHONE });
});

test('phone number for existing user fetches and returns wallet address', async () => {
  const wallets = { [VALID_PHONE]: { publicKey: WALLET_ACCOUNT, id: 'w_existing' } };
  const resolve = createRecipientResolver({
    prisma: prismaWithAliases({}),
    walletService: walletServiceMock(wallets),
  });
  const result = await resolve(user, VALID_PHONE);
  assert.deepEqual(result, { destination: WALLET_ACCOUNT, label: VALID_PHONE });
});

test('saved contact wins precedence over phone-shaped number', async () => {
  const resolve = createRecipientResolver({
    prisma: prismaWithAliases({ [VALID_PHONE]: { target: CONTACT_ACCOUNT, targetType: 'stellar' } }),
    walletService: walletServiceMock(),
  });
  const result = await resolve(user, VALID_PHONE);
  // Should return the saved contact, not create/fetch wallet
  assert.deepEqual(result, { destination: CONTACT_ACCOUNT, label: VALID_PHONE.toLowerCase() });
});
