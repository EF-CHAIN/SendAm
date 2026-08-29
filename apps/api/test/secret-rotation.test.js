const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const srcRoot = path.resolve(__dirname, '../src');

const injectMock = (relFromSrc, factory) => {
  const abs = path.resolve(srcRoot, `${relFromSrc}.js`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: factory() };
};

let rotations = [];
injectMock('common/prisma', () => ({
  secretRotation: {
    create: async (data) => {
      const row = { id: `rot-${Date.now()}`, ...data.data };
      rotations.push(row);
      return row;
    },
    findMany: async () => rotations,
  },
}));
injectMock('common/audit.service', () => ({ writeAuditLog: async () => {} }));

const {
  SECRET_CATEGORIES,
  ROTATION_CADENCE_DAYS,
  ROTATION_OWNERS,
  generateSecretValue,
  getSecretHash,
  getRotationDueDate,
  isRotationExpiringSoon,
  rotateSecret,
  getRotationStatus,
} = require('../src/services/secret-rotation.service');

describe('secret-rotation.service', () => {
  beforeEach(() => {
    rotations = [];
  });

  test('SECRET_CATEGORIES lists all supported categories', () => {
    assert.ok(Object.keys(SECRET_CATEGORIES).length > 0);
    assert.ok(SECRET_CATEGORIES.ENCRYPTION_KEY);
    assert.ok(SECRET_CATEGORIES.JWT_SECRET);
  });

  test('ROTATION_CADENCE_DAYS has an entry for every category', () => {
    for (const cat of Object.keys(SECRET_CATEGORIES)) {
      assert.ok(ROTATION_CADENCE_DAYS[cat], `Missing cadence for ${cat}`);
    }
  });

  test('ROTATION_OWNERS has an owner for every category', () => {
    for (const cat of Object.keys(SECRET_CATEGORIES)) {
      assert.ok(ROTATION_OWNERS[cat], `Missing owner for ${cat}`);
    }
  });

  test('generateSecretValue returns a hex string', () => {
    const val = generateSecretValue();
    assert.ok(/^[0-9a-f]+$/.test(val));
    assert.ok(val.length > 0);
  });

  test('getSecretHash returns a stable 16-char hex', () => {
    const h1 = getSecretHash('my-secret');
    const h2 = getSecretHash('my-secret');
    assert.strictEqual(h1, h2);
    assert.strictEqual(h1.length, 16);
  });

  test('getRotationDueDate returns future date for recently rotated secret', () => {
    const rotatedAt = new Date();
    const due = getRotationDueDate('ENCRYPTION_KEY', rotatedAt);
    assert.ok(due > new Date(), `due ${due.toISOString()} should be after now`);
  });

  test('getRotationDueDate returns future date even for old rotation', () => {
    const rotatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const due = getRotationDueDate('ENCRYPTION_KEY', rotatedAt);
    assert.ok(due > new Date(), `due ${due.toISOString()} should be after now`);
  });

  test('isRotationExpiringSoon returns true for dates within warning window', () => {
    const soon = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
    assert.strictEqual(isRotationExpiringSoon(soon, 30), true);
  });

  test('isRotationExpiringSoon returns false for distant dates', () => {
    const far = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    assert.strictEqual(isRotationExpiringSoon(far, 30), false);
  });

  test('rotateSecret creates a rotation record', async () => {
    const result = await rotateSecret({ category: 'ENCRYPTION_KEY', newValue: 'new-secret-value', rotatedBy: 'admin-1' });
    assert.strictEqual(result.category, 'ENCRYPTION_KEY');
    assert.ok(result.hash);
    assert.ok(result.expiresAt);
  });

  test('rotateSecret throws for unknown category', async () => {
    await assert.rejects(() => rotateSecret({ category: 'UNKNOWN', newValue: 'x', rotatedBy: 'system' }), { statusCode: 400 });
  });

  test('getRotationStatus returns rotations and health', async () => {
    await rotateSecret({ category: 'ENCRYPTION_KEY', newValue: 'secret-1', rotatedBy: 'system' });
    const status = await getRotationStatus();
    assert.ok(Array.isArray(status.rotations));
    assert.strictEqual(status.rotations.length, 1);
    assert.ok(Array.isArray(status.health));
  });
});
