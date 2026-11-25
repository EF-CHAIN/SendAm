const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  handoffUnrecognizedMessage,
} = require('../src/support/agentHandoff');

test('three consecutive unrecognized messages create one support case and reset the counter', async () => {
  const user = { id: 'user-1', phoneNumber: '+15555550123', supportUnrecognizedCount: 0 };
  let createdCase;
  const prisma = {
    user: {
      update: async ({ data }) => {
        Object.assign(user, data);
        return user;
      },
    },
    supportCase: {
      findFirst: async () => createdCase,
      create: async ({ data }) => {
        createdCase = { id: 'case-1', ...data };
        return createdCase;
      },
    },
    supportCaseComment: { create: async () => ({}) },
  };

  assert.equal((await handoffUnrecognizedMessage({ prisma, user })).escalated, false);
  assert.equal((await handoffUnrecognizedMessage({ prisma, user })).escalated, false);
  const result = await handoffUnrecognizedMessage({ prisma, user });

  assert.equal(result.escalated, true);
  assert.equal(result.supportCase.userId, user.id);
  assert.equal(user.supportUnrecognizedCount, 0);
});
