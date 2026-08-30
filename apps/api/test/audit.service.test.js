const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const inject = (relative, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relative}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
let logged;
inject('common/prisma', { 
  $transaction: async (cb) => { 
    return await cb({ 
      auditLog: { 
        findFirst: async () => null,
        create: async () => { throw new Error('audit database unavailable'); }
      } 
    }); 
  } 
});
inject('utils/logger', { error: (...args) => { logged = args; } });

const { writeAuditLog } = require('../src/common/audit.service');

test('audit persistence failure degrades safely without rejecting authentication', async () => {
  const result = await writeAuditLog({ action: 'auth.session.created' });
  assert.equal(result, null);
  assert.equal(logged[0], 'Failed to write audit log');
  assert.equal(logged[1], 'audit database unavailable');
});
