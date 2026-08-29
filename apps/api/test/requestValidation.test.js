const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { validateRequest } = require('../src/middlewares/validateRequest');

const buildApp = () => {
  const app = express();
  app.use(express.json());

  app.post(
    '/demo',
    validateRequest({
      body: {
        allowedKeys: ['phoneNumber', 'locale'],
        required: ['phoneNumber'],
        fields: {
          phoneNumber: {
            type: 'string',
            trim: true,
            custom: (value) => value.length > 5,
            message: 'A valid phone number is required',
          },
          locale: {
            type: 'string',
            optional: true,
          },
        },
      },
    }),
    (req, res) => {
      res.status(200).json({ ok: true, phoneNumber: req.body.phoneNumber });
    },
  );

  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Server Error',
      errors: err.errors || {},
    });
  });

  return app;
};

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

test('validateRequest rejects unknown fields and malformed required values', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/demo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '123', debug: true }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.message, 'Validation failed');
    assert.ok(body.errors['body.phoneNumber']);
    assert.ok(body.errors['body.debug']);
  });
});

test('validateRequest allows valid payloads through to the route', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/demo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+2348000000001', locale: 'en' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.phoneNumber, '+2348000000001');
  });
});
