process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'b'.repeat(64);
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'testpassword123';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath,
  filename: prismaClientPath,
  loaded: true,
  exports: { Prisma: { DbNull: null, AnyNull: null } },
};

const resetModule = (relativePath, exports) => {
  const abs = path.resolve(__dirname, '../src', `${relativePath}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
};

test('registerWhatsAppJobs registers the outbound retry processor', async () => {
  const calls = [];
  resetModule('queues/queue.service', {
    registerProcessor: (name, processor) => {
      calls.push({ name, processor });
      return { name };
    },
    enqueue: async () => ({ id: 'job_1' }),
  });

  resetModule('common/prisma', {
    notification: { create: async () => ({ id: 'n_1' }), update: async () => ({ id: 'n_1' }) },
  });

  delete require.cache[path.resolve(__dirname, '../src/jobs/whatsapp.jobs.js')];
  const { registerWhatsAppJobs } = require('../src/jobs/whatsapp.jobs');
  registerWhatsAppJobs();

  assert.deepEqual(calls.map((call) => call.name).sort(), ['whatsapp-inbound', 'whatsapp-outbound-retry']);
});

test('sendTextMessage queues a retry for transient Meta errors and records the notification', async () => {
  const notificationStore = new Map();
  let queuedJob = null;

  resetModule('queues/queue.service', {
    registerProcessor: () => ({ name: 'worker' }),
    enqueue: async (name, jobName, data) => {
      queuedJob = { name, jobName, data };
      return { id: 'job_retry_1' };
    },
  });

  resetModule('common/prisma', {
    notification: {
      create: async ({ data }) => {
        const row = { id: 'n_1', ...data, status: 'queued' };
        notificationStore.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const current = notificationStore.get(where.id);
        const updated = { ...current, ...data };
        notificationStore.set(where.id, updated);
        return updated;
      },
      findUnique: async ({ where }) => notificationStore.get(where.id) || null,
    },
  });

  delete require.cache[path.resolve(__dirname, '../src/services/whatsapp.service.js')];
  const { sendTextMessage } = require('../src/services/whatsapp.service');

  const axiosImpl = {
    post: async () => {
      const error = new Error('Meta API timeout');
      error.response = { status: 500, data: { error: 'timeout' } };
      throw error;
    },
  };

  const result = await sendTextMessage('+2348000000001', 'hello', {
    messageTransport: 'meta',
    axiosImpl,
  });

  assert.equal(result, null);
  assert.ok(queuedJob);
  assert.equal(queuedJob.name, 'whatsapp-outbound-retry');
  assert.equal(queuedJob.jobName, 'notification.retry');
  assert.equal(queuedJob.data.notificationId, 'n_1');
  assert.equal(notificationStore.get('n_1').status, 'queued');
});
