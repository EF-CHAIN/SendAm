const { test } = require('node:test');
const assert = require('node:assert/strict');

const { claimPendingSend } = require('../src/whatsapp/pendingClaim');

// Stand-ins for @prisma/client's Json-null sentinels — the claim logic only
// threads them through, so symbols are enough to assert placement.
const Prisma = { DbNull: Symbol('DbNull'), AnyNull: Symbol('AnyNull') };

const stubPrisma = (counts) => {
  const calls = [];
  return {
    calls,
    user: {
      updateMany: async (args) => {
        calls.push(args);
        return { count: counts.shift() ?? 0 };
      },
    },
  };
};

test('claims with an atomic compare-and-clear: AnyNull filter, DbNull write', async () => {
  const prisma = stubPrisma([1]);
  const won = await claimPendingSend({ prisma, Prisma, userId: 'u_1' });

  assert.equal(won, true);
  assert.equal(prisma.calls.length, 1);
  assert.deepEqual(prisma.calls[0], {
    where: { id: 'u_1', NOT: { pendingSend: { equals: Prisma.AnyNull } } },
    data: { pendingSend: Prisma.DbNull },
  });
});

test('returns false when no pending send existed to claim', async () => {
  const prisma = stubPrisma([0]);
  assert.equal(await claimPendingSend({ prisma, Prisma, userId: 'u_1' }), false);
});

test('double-confirm race: two concurrent claimers, exactly one winner', async () => {
  // The database grants the row to exactly one UPDATE; the stub models that
  // by returning count 1 to the first caller and 0 to the second.
  const prisma = stubPrisma([1, 0]);

  const [first, second] = await Promise.all([
    claimPendingSend({ prisma, Prisma, userId: 'u_1' }),
    claimPendingSend({ prisma, Prisma, userId: 'u_1' }),
  ]);

  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(prisma.calls.length, 2);
});
