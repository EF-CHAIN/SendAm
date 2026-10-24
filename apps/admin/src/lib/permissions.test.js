import { describe, it, expect } from 'vitest';
import { hasPermission } from './permissions';

// permissions.js does not define a role table itself: it evaluates the
// permission list the server issues for the signed-in admin. The authoritative
// matrix is ROLE_PERMISSIONS in apps/api/src/services/adminAuth.service.js; it
// is mirrored here as a fixture (importing the API service would pull Prisma
// and server config into the admin test run). If a role's permissions change on
// the server, update this fixture and the expectations below together.
const ROLE_PERMISSIONS = {
  read_only: ['admin.read'],
  compliance: ['admin.read', 'compliance.read', 'compliance.write'],
  operations: ['admin.read', 'operations.write'],
  administrator: ['*'],
};

const KNOWN_PERMISSIONS = [
  'admin.read',
  'compliance.read',
  'compliance.write',
  'operations.write',
];

const EXPECTED_GRANTS = {
  read_only: ['admin.read'],
  compliance: ['admin.read', 'compliance.read', 'compliance.write'],
  operations: ['admin.read', 'operations.write'],
  administrator: KNOWN_PERMISSIONS,
};

describe('hasPermission per role', () => {
  for (const [role, expected] of Object.entries(EXPECTED_GRANTS)) {
    it(`${role}: grants exactly ${expected.join(', ')}`, () => {
      const granted = KNOWN_PERMISSIONS.filter((p) => hasPermission(ROLE_PERMISSIONS[role], p));
      expect(granted).toEqual(KNOWN_PERMISSIONS.filter((p) => expected.includes(p)));
    });
  }

  it('administrator (wildcard) is also granted permissions no other role has', () => {
    expect(hasPermission(ROLE_PERMISSIONS.administrator, 'brand.new.permission')).toBe(true);
  });

  it('non-administrator roles are denied unlisted permissions', () => {
    for (const role of ['read_only', 'compliance', 'operations']) {
      expect(hasPermission(ROLE_PERMISSIONS[role], 'brand.new.permission')).toBe(false);
    }
  });

  it('every role can read the admin area', () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      expect(hasPermission(permissions, 'admin.read')).toBe(true);
    }
  });
});

describe('hasPermission input handling', () => {
  it('grants a wildcard even when mixed with explicit entries', () => {
    expect(hasPermission(['admin.read', '*'], 'compliance.write')).toBe(true);
  });

  it('matches permission names exactly, without prefix or substring matching', () => {
    const scoped = ['admin.read'];

    expect(hasPermission(scoped, 'admin')).toBe(false);
    expect(hasPermission(scoped, 'admin.read.all')).toBe(false);
    expect(hasPermission(scoped, 'ADMIN.READ')).toBe(false);
  });

  it('denies everything for an empty permission list', () => {
    expect(hasPermission([], 'admin.read')).toBe(false);
  });

  it('denies everything for an unknown role (no permission list)', () => {
    expect(hasPermission(ROLE_PERMISSIONS.superuser, 'admin.read')).toBe(false);
    expect(hasPermission(undefined, 'admin.read')).toBe(false);
    expect(hasPermission(null, 'admin.read')).toBe(false);
  });

  it('does not treat a literal "*" request as satisfied by a scoped role', () => {
    expect(hasPermission(['admin.read'], '*')).toBe(false);
  });

  it('always returns a strict boolean', () => {
    expect(hasPermission(['*'], 'x')).toBe(true);
    expect(hasPermission(undefined, 'x')).toBe(false);
  });
});
