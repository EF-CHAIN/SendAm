const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRecipientResolver } = require('../src/whatsapp/recipientResolver');

const STELLAR_ACCOUNT = `G${'A'.repeat(55)}`;
const user = { id: 'u_1' };

const prismaWithAliases = (aliases) => ({
  alias: {
    findUnique: async ({ where }) => aliases[where.userId_alias.alias] ?? null,
  },
});

const nsWith = (names, enabled = true) => ({
  enabled,
  resolveName: async (raw) => {
    const name = raw.startsWith('@') ? raw.slice(1) : raw.split('*')[0];
    return names[name] ? { accountId: names[name], stellarAddress: `${name}*sendam.app` } : null;
  },
});

test('saved contacts win for bare names', async () => {
  const resolve = createRecipientResolver({
    prisma: prismaWithAliases({ mama: { target: '0xab12ab12ab12ab12ab12ab12ab12ab12ab12ab12', targetType: 'lisk' } }),
    nsClient: nsWith({}),
  });
  const result = await resolve(user, 'Mama ');
  assert.deepEqual(result, { destination: '0xab12ab12ab12ab12ab12ab12ab12ab12ab12ab12', label: 'mama' });
});

test('sigil-prefixed names resolve through the NS', async () => {
  const resolve = createRecipientResolver({
    prisma: prismaWithAliases({}),
    nsClient: nsWith({ ada: STELLAR_ACCOUNT }),
  });
  assert.deepEqual(await resolve(user, '@ada'), { destination: STELLAR_ACCOUNT, label: '@ada' });
  assert.deepEqual(await resolve(user, 'ada*sendam.app'), { destination: STELLAR_ACCOUNT, label: 'ada*sendam.app' });
});

test('collision rule: bare name hits the contact, @name hits the global registry', async () => {
  const contactTarget = '0xcd34cd34cd34cd34cd34cd34cd34cd34cd34cd34';
  const resolve = createRecipientResolver({
    prisma: prismaWithAliases({ ada: { target: contactTarget } }),
    nsClient: nsWith({ ada: STELLAR_ACCOUNT }),
  });

  assert.equal((await resolve(user, 'ada')).destination, contactTarget);
  assert.equal((await resolve(user, '@ada')).destination, STELLAR_ACCOUNT);
});

test('a saved alias that IS sigil-form still wins over NS (contacts first)', async () => {
  const contactTarget = '0xcd34cd34cd34cd34cd34cd34cd34cd34cd34cd34';
  const resolve = createRecipientResolver({
    prisma: prismaWithAliases({ '@ada': { target: contactTarget } }),
    nsClient: nsWith({ ada: STELLAR_ACCOUNT }),
  });
  assert.equal((await resolve(user, '@ada')).destination, contactTarget);
});

test('bare names never reach the NS; unknown bare names pass through raw', async () => {
  let nsCalled = false;
  const resolve = createRecipientResolver({
    prisma: prismaWithAliases({}),
    nsClient: {
      enabled: true,
      resolveName: async () => {
        nsCalled = true;
        return { accountId: STELLAR_ACCOUNT };
      },
    },
  });
  const result = await resolve(user, 'ada');
  assert.equal(nsCalled, false);
  assert.deepEqual(result, { destination: 'ada', label: 'ada' });
});

test('NS disabled or unknown global name falls through to raw passthrough', async () => {
  const disabled = createRecipientResolver({ prisma: prismaWithAliases({}), nsClient: nsWith({ ada: STELLAR_ACCOUNT }, false) });
  assert.deepEqual(await disabled(user, '@ada'), { destination: '@ada', label: '@ada' });

  const unknown = createRecipientResolver({ prisma: prismaWithAliases({}), nsClient: nsWith({}) });
  assert.deepEqual(await unknown(user, '@ghost'), { destination: '@ghost', label: '@ghost' });
});

test('raw addresses pass through untouched (validation happens downstream)', async () => {
  const resolve = createRecipientResolver({ prisma: prismaWithAliases({}), nsClient: nsWith({}) });
  const result = await resolve(user, STELLAR_ACCOUNT);
  assert.deepEqual(result, { destination: STELLAR_ACCOUNT, label: STELLAR_ACCOUNT });
});
