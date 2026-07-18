const { test } = require('node:test');
const assert = require('node:assert/strict');

// Set key to prevent startup validateEnv issues if config is loaded
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { sendTextMessage } = require('../src/services/whatsapp.service');

test('sim mode writes the row and never calls Meta', async () => {
  const dbCalls = [];
  const fakePrisma = {
    simMessage: {
      create: async (args) => {
        dbCalls.push(args);
        return { id: 'sim_1', ...args.data };
      }
    }
  };

  const fakeAxios = {
    post: async () => {
      throw new Error('Meta API should not be called in sim mode');
    }
  };

  const result = await sendTextMessage('+12345', 'Hello from sim', {
    messageTransport: 'sim',
    prisma: fakePrisma,
    axiosImpl: fakeAxios,
  });

  assert.equal(result.id, 'sim_1');
  assert.equal(result.phoneNumber, '+12345');
  assert.equal(result.direction, 'out');
  assert.equal(result.text, 'Hello from sim');
  assert.equal(dbCalls.length, 1);
  assert.deepEqual(dbCalls[0], {
    data: {
      phoneNumber: '+12345',
      direction: 'out',
      text: 'Hello from sim',
    }
  });
});

test('meta mode calls Meta exactly as before', async () => {
  let seenPost;
  const fakeAxios = {
    post: async (url, payload, options) => {
      seenPost = { url, payload, options };
      return { data: { success: true, message_id: 'meta_1' } };
    }
  };

  const result = await sendTextMessage('+12345', 'Hello from meta', {
    messageTransport: 'meta',
    axiosImpl: fakeAxios,
  });

  assert.deepEqual(result, { success: true, message_id: 'meta_1' });
  assert.equal(seenPost.url.includes('/messages'), true);
  assert.equal(seenPost.payload.to, '+12345');
  assert.equal(seenPost.payload.text.body, 'Hello from meta');
});
