const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Keypair } = require('@stellar/stellar-sdk');

const { createFederationRouter } = require('../src/routes/federation.routes');

const withServer = async (router, run) => {
  const app = express();
  app.use('/federation', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('SEP-2 GET /federation?q=+2348012345678*sendam.io&type=name returns account_id and CORS header', async () => {
  const kp = Keypair.random();
  const mockPrisma = {
    user: {
      findUnique: async ({ where }) => {
        if (where.phoneNumber === '+2348012345678') {
          return {
            id: 'user-1',
            phoneNumber: '+2348012345678',
            deletedAt: null,
            deactivatedAt: null,
            wallets: [{ chain: 'stellar', publicKey: kp.publicKey() }],
          };
        }
        return null;
      },
    },
  };

  const router = createFederationRouter({ prismaClient: mockPrisma, domain: 'sendam.io' });
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/federation?q=${encodeURIComponent('+2348012345678*sendam.io')}&type=name`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.deepEqual(body, {
      stellar_address: '+2348012345678*sendam.io',
      account_id: kp.publicKey(),
    });
  });
});

test('SEP-2 GET /federation includes optional memo and memo_type when resolver provides one', async () => {
  const kp = Keypair.random();
  const mockPrisma = {
    user: {
      findUnique: async () => ({
        id: 'user-42',
        phoneNumber: '+2348012345678',
        deletedAt: null,
        deactivatedAt: null,
        wallets: [{ chain: 'stellar', publicKey: kp.publicKey() }],
      }),
    },
  };

  const router = createFederationRouter({
    prismaClient: mockPrisma,
    domain: 'sendam.io',
    resolveMemo: (user) => ({ memo: `uid:${user.id}`, memo_type: 'text' }),
  });

  await withServer(router, async (base) => {
    const res = await fetch(`${base}/federation?q=${encodeURIComponent('+2348012345678*sendam.io')}&type=name`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.account_id, kp.publicKey());
    assert.equal(body.memo_type, 'text');
    assert.equal(body.memo, 'uid:user-42');
  });
});

test('SEP-2 GET /federation returns 404 for unknown user, wrong domain, or deactivated user', async () => {
  const mockPrisma = {
    user: {
      findUnique: async ({ where }) => {
        if (where.phoneNumber === '+2348099999999') {
          return {
            id: 'user-deactivated',
            phoneNumber: '+2348099999999',
            deletedAt: null,
            deactivatedAt: new Date(),
            wallets: [{ chain: 'stellar', publicKey: Keypair.random().publicKey() }],
          };
        }
        return null;
      },
    },
  };

  const router = createFederationRouter({ prismaClient: mockPrisma, domain: 'sendam.io' });
  await withServer(router, async (base) => {
    const unknown = await fetch(`${base}/federation?q=${encodeURIComponent('+2348011111111*sendam.io')}&type=name`);
    assert.equal(unknown.status, 404);

    const wrongDomain = await fetch(`${base}/federation?q=${encodeURIComponent('+2348012345678*other.io')}&type=name`);
    assert.equal(wrongDomain.status, 404);

    const deactivated = await fetch(`${base}/federation?q=${encodeURIComponent('+2348099999999*sendam.io')}&type=name`);
    assert.equal(deactivated.status, 404);
  });
});

test('SEP-2 GET /federation supports type=id reverse lookup and rejects invalid queries with 400', async () => {
  const kp = Keypair.random();
  const mockPrisma = {
    wallet: {
      findFirst: async ({ where }) => {
        if (where.publicKey === kp.publicKey()) {
          return {
            publicKey: kp.publicKey(),
            user: { phoneNumber: '+2348012345678', deletedAt: null, deactivatedAt: null },
          };
        }
        return null;
      },
    },
  };

  const router = createFederationRouter({ prismaClient: mockPrisma, domain: 'sendam.io' });
  await withServer(router, async (base) => {
    const reverse = await fetch(`${base}/federation?q=${encodeURIComponent(kp.publicKey())}&type=id`);
    assert.equal(reverse.status, 200);
    assert.deepEqual(await reverse.json(), {
      stellar_address: '+2348012345678*sendam.io',
      account_id: kp.publicKey(),
    });

    const missingParams = await fetch(`${base}/federation?q=foo`);
    assert.equal(missingParams.status, 400);

    const badType = await fetch(`${base}/federation?q=foo*sendam.io&type=txid`);
    assert.equal(badType.status, 400);
  });
});
