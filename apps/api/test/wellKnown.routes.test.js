const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const toml = require('toml');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JWT_SECRET = process.env.JWT_SECRET || '0123456789abcdef0123456789abcdef0123456789abcdef';

const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath,
  filename: prismaClientPath,
  loaded: true,
  exports: { Prisma: { DbNull: null, AnyNull: null }, PrismaClient: class {} },
};

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// Mock admin auth & audit services for isolated testing
const adminUser = {
  id: 'admin-1',
  email: 'admin@sendam.app',
  role: { permissions: ['*'] },
};

inject('common/prisma', {});
inject('common/audit.service', { writeAuditLog: async () => null });
inject('middlewares/requireAdmin', () => (req, res, next) => {
  if (req.headers.authorization !== 'Bearer valid-admin-token') {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  req.admin = adminUser;
  next();
});

const wellKnownRoutes = require('../src/routes/wellKnown.routes');
const adminRoutes = require('../src/routes/admin.routes');
const errorHandler = require('../src/middlewares/errorHandler');

const buildApp = () => {
  const app = express();
  app.use(express.json());

  // Mount well-known routes (which enforce open CORS)
  app.use(wellKnownRoutes);

  // Simulated restricted CORS middleware for application API routes
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== 'http://localhost:3000' && req.path.startsWith('/api')) {
      return res.status(403).json({ success: false, message: 'Not allowed by CORS' });
    }
    next();
  });

  app.use('/api/admin', adminRoutes);
  app.use(errorHandler);
  return app;
};

const withServer = async (run) => {
  const app = buildApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('GET /.well-known/stellar.toml returns 200, text/plain, and open CORS', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/.well-known/stellar.toml`, {
      headers: {
        Origin: 'https://stellar.expert',
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');

    const body = await res.text();
    assert.ok(body.includes('NETWORK_PASSPHRASE'));
    assert.ok(body.includes('SIGNING_KEY'));
    assert.ok(body.includes('WEB_AUTH_ENDPOINT'));
    assert.ok(body.includes('[[CURRENCIES]]'));

    // Verify format parses cleanly
    const parsed = toml.parse(body);
    assert.ok(parsed.NETWORK_PASSPHRASE);
    assert.ok(parsed.SIGNING_KEY);
    assert.ok(parsed.WEB_AUTH_ENDPOINT);
    assert.ok(Array.isArray(parsed.CURRENCIES));
    assert.ok(parsed.CURRENCIES.length >= 2);
  });
});

test('OPTIONS /.well-known/stellar.toml handles preflight with open CORS', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/.well-known/stellar.toml`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://laboratory.stellar.org',
        'Access-Control-Request-Method': 'GET',
      },
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(res.headers.get('access-control-allow-methods').includes('GET'));
  });
});

test('GET /stellar.toml serves identical content with CORS', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/stellar.toml`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.text();
    assert.ok(body.includes('VERSION = "2.0.0"'));
  });
});

test('GET /api/admin/stellar/toml requires authentication', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/admin/stellar/toml`);
    assert.equal(res.status, 401);
  });
});

test('GET /api/admin/stellar/toml returns parsed and serialized TOML for authenticated admin', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/admin/stellar/toml`, {
      headers: { Authorization: 'Bearer valid-admin-token' },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.toml);
    assert.equal(body.data.valid, true);
    assert.ok(body.data.parsed);
    assert.ok(body.data.summary.signingKey);
  });
});

test('GET /api/admin/stellar/toml/validate validates current live configuration', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/admin/stellar/toml/validate`, {
      headers: { Authorization: 'Bearer valid-admin-token' },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.valid, true);
    assert.equal(body.data.errors.length, 0);
    assert.ok(body.data.summary.currencies.includes('USDC'));
  });
});

test('POST /api/admin/stellar/toml/validate evaluates custom candidate TOML', async () => {
  await withServer(async (base) => {
    // Valid candidate
    const validCandidate = [
      'VERSION = "2.0.0"',
      'NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"',
      'SIGNING_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"',
      'WEB_AUTH_ENDPOINT = "https://api.sendam.app/api/auth"',
      '[[CURRENCIES]]',
      'code = "XLM"',
    ].join('\n');

    const validRes = await fetch(`${base}/api/admin/stellar/toml/validate`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ toml: validCandidate }),
    });

    assert.equal(validRes.status, 200);
    const validBody = await validRes.json();
    assert.equal(validBody.success, true);
    assert.equal(validBody.data.valid, true);

    // Invalid candidate (missing required SIGNING_KEY)
    const invalidCandidate = [
      'VERSION = "2.0.0"',
      'NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"',
      'WEB_AUTH_ENDPOINT = "https://api.sendam.app/api/auth"',
    ].join('\n');

    const invalidRes = await fetch(`${base}/api/admin/stellar/toml/validate`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ toml: invalidCandidate }),
    });

    assert.equal(invalidRes.status, 200);
    const invalidBody = await invalidRes.json();
    assert.equal(invalidBody.success, true);
    assert.equal(invalidBody.data.valid, false);
    assert.ok(invalidBody.data.errors.some((e) => e.includes('SIGNING_KEY')));
  });
});
