const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRecipientResolver } = require('../src/whatsapp/recipientResolver');

const STELLAR_ACCOUNT = `G${'A'.repeat(55)}`;
const CONTACT_ACCOUNT = `G${'B'.repeat(55)}`;
const user = { id: 'u_1' };

const prismaWithAliases = (aliases) => ({
  alias: {
    findUnique: async ({ where }) => aliases[where.userId_alias.alias] ?? null,
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
