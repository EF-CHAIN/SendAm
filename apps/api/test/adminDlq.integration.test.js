const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

injectMock('middlewares/requireAdmin', () => (req, _res, next) => {
  req.admin = { id: 'admin-test-1', role: 'administrator', permissions: ['*'] };
  next();
});

const {
  moveToDeadLetterQueue,
  clearDlq,
} = require('../src/queues/dlq.service');

const adminRoutes = require('../src/routes/admin.routes');

const withServer = async (app, run) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  });
  return app;
};

beforeEach(async () => {
  await clearDlq();
});

test('Admin DLQ: list, inspect, replay, and discard dead-letter jobs', async (t) => {
  await t.test('GET /api/admin/dlq returns redacted list of dead-letter jobs', async () => {
    const record = await moveToDeadLetterQueue(
      {
        id: 'job-dlq-1',
        data: { from: '+2348011223344', whatsappMessageId: 'wamid.1', text: 'send 10', pin: '1234' },
      },
      new Error('Test error'),
    );

    await withServer(buildApp(), async (base) => {
      const res = await fetch(`${base}/api/admin/dlq`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.ok(Array.isArray(body.data.jobs));
      assert.equal(body.data.jobs.length, 1);
      assert.equal(body.data.jobs[0].id, record.id);
      assert.equal(body.data.jobs[0].payload.pin, '[REDACTED]');
    });
  });

  await t.test('GET /api/admin/dlq/:id returns details of single job', async () => {
    const record = await moveToDeadLetterQueue(
      {
        id: 'job-dlq-2',
        data: { from: '+2348011223344', whatsappMessageId: 'wamid.2', text: 'send 10' },
      },
      new Error('Horizon timeout'),
    );

    await withServer(buildApp(), async (base) => {
      const res = await fetch(`${base}/api/admin/dlq/${record.id}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.job.id, record.id);
      assert.equal(body.data.job.status, 'pending');
    });
  });

  await t.test('POST /api/admin/dlq/:id/replay triggers replay and updates status', async () => {
    const record = await moveToDeadLetterQueue(
      {
        id: 'job-dlq-3',
        data: { from: '+2348011223344', whatsappMessageId: 'wamid.3', text: 'send 10' },
      },
      new Error('Stellar timeout'),
    );

    await withServer(buildApp(), async (base) => {
      const res = await fetch(`${base}/api/admin/dlq/${record.id}/replay`, {
        method: 'POST',
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.replayed, true);
      assert.equal(body.data.record.status, 'replayed');
    });
  });

  await t.test('DELETE /api/admin/dlq/:id discards the dead letter job', async () => {
    const recordToDiscard = await moveToDeadLetterQueue(
      { id: 'job-discard-test', data: { text: 'discard me' } },
      new Error('Permanent syntax error'),
    );

    await withServer(buildApp(), async (base) => {
      const res = await fetch(`${base}/api/admin/dlq/${recordToDiscard.id}`, {
        method: 'DELETE',
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.discarded, true);
      assert.equal(body.data.record.status, 'discarded');
    });
  });
});
