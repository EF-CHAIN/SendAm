const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Configure environment before app require: CORS allowlist plus the minimum
// runtime secrets (crypto/service throws at require-time without ENCRYPTION_KEY,
// and admin auth validates JWT_SECRET) so the app module can load offline.
process.env.CORS_ORIGINS = 'https://dashboard.example.com,http://localhost:3000';
process.env.ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex
process.env.JWT_SECRET = 'cors-test-jwt-secret-that-is-at-least-32-characters-long-';

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
      // Use a static 200 route (the OpenAPI spec) rather than /health: /health
      // delegates to live DB+Redis checks and would flake without those services.
      const res = await fetch(`${baseUrl}/api/docs`);
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
