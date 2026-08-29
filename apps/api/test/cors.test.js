const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Configure CORS environment before app require
process.env.CORS_ORIGINS = 'https://dashboard.example.com,http://localhost:3000';

const app = require('../src/app');

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

test('CORS Policy', async (t) => {
  await t.test('allows configured origin (production)', async () => {
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://dashboard.example.com',
          'Access-Control-Request-Method': 'GET',
        }
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://dashboard.example.com');
    });
  });

  await t.test('allows configured origin (local development)', async () => {
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET',
        }
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    });
  });

  await t.test('allows non-browser requests without Origin header', async () => {
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
    });
  });

  await t.test('rejects unapproved origin with 403', async () => {
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { 'Origin': 'https://evil.com' }
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.message, 'Not allowed by CORS');
    });
  });

  await t.test('rejects malformed/null origin with 403', async () => {
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { 'Origin': 'null' }
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.success, false);
      assert.match(body.message, /null origin not allowed/);
    });
  });
});
