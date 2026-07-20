const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers: inject a mock module into require.cache so the SUT gets it
// ---------------------------------------------------------------------------
const injectMock = (relativeFromSrc, factory) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    exports: factory(),
  };
};

const mocks = {
  create: mock.fn(),
  findMany: mock.fn(),
};

const resetMockCalls = () => { for (const fn of Object.values(mocks)) fn.mock.resetCalls(); };

injectMock('common/prisma', () => ({
  simMessage: { create: mocks.create, findMany: mocks.findMany },
}));

// ---------------------------------------------------------------------------
// SUT – loaded after the mock is in place
// ---------------------------------------------------------------------------
const { appendMessage, listMessages, listMessagesSince } = require('../src/services/simMessage.service');

test('appendMessage', async (t) => {
  t.beforeEach(resetMockCalls);

  await t.test('creates a row with phoneNumber, direction, and text', async () => {
    const row = { id: 'm1', phoneNumber: '+2348000000001', direction: 'in', text: 'balance', createdAt: new Date() };
    mocks.create.mock.mockImplementation(() => row);

    const result = await appendMessage({ phoneNumber: '+2348000000001', direction: 'in', text: 'balance' });

    assert.equal(mocks.create.mock.callCount(), 1);
    assert.deepEqual(mocks.create.mock.calls[0].arguments[0], {
      data: { phoneNumber: '+2348000000001', direction: 'in', text: 'balance' },
    });
    assert.equal(result, row);
  });
});

test('listMessages', async (t) => {
  t.beforeEach(resetMockCalls);

  await t.test('returns all messages for a phone number ordered oldest first', async () => {
    const rows = [
      { id: 'm1', phoneNumber: '+2348000000001', direction: 'in', text: 'hi', createdAt: new Date('2026-01-01') },
      { id: 'm2', phoneNumber: '+2348000000001', direction: 'out', text: 'hello', createdAt: new Date('2026-01-02') },
    ];
    mocks.findMany.mock.mockImplementation(() => rows);

    const result = await listMessages('+2348000000001');

    assert.equal(mocks.findMany.mock.callCount(), 1);
    assert.deepEqual(mocks.findMany.mock.calls[0].arguments[0], {
      where: { phoneNumber: '+2348000000001' },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(result, rows);
  });
});

test('listMessagesSince', async (t) => {
  t.beforeEach(resetMockCalls);

  await t.test('filters to strictly-newer messages, ordered oldest first', async () => {
    mocks.findMany.mock.mockImplementation(() => []);
    const since = '2026-01-01T00:00:00.000Z';

    await listMessagesSince('+2348000000001', since);

    assert.equal(mocks.findMany.mock.callCount(), 1);
    const call = mocks.findMany.mock.calls[0].arguments[0];
    assert.equal(call.where.phoneNumber, '+2348000000001');
    assert.deepEqual(call.orderBy, { createdAt: 'asc' });
    assert.ok(call.where.createdAt.gt instanceof Date);
    assert.equal(call.where.createdAt.gt.toISOString(), since);
  });

  await t.test('excludes rows at or before since, includes rows after (integration-style behavior check)', async () => {
    const since = new Date('2026-01-02T00:00:00.000Z');
    const older = { id: 'm1', createdAt: new Date('2026-01-01T00:00:00.000Z') };
    const same = { id: 'm2', createdAt: new Date('2026-01-02T00:00:00.000Z') };
    const newer = { id: 'm3', createdAt: new Date('2026-01-03T00:00:00.000Z') };

    mocks.findMany.mock.mockImplementation(({ where }) =>
      [older, same, newer].filter((m) => m.createdAt > where.createdAt.gt));

    const result = await listMessagesSince('+2348000000001', since.toISOString());

    assert.deepEqual(result, [newer]);
  });
});
