/**
 * Scenario preconditions.
 *
 * The point of these is that a scenario which cannot measure what it claims to
 * must refuse to run. Silently degrading — measuring the 401 path and calling
 * it an admin-read result — produces a green run that establishes nothing,
 * which is worse than a red one.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { byName, SCENARIOS } = require('../load/scenarios');

const url = new URL('http://127.0.0.1:3002');

test('admin-read refuses to run without a token rather than measuring 401s', () => {
  assert.throws(
    () => byName.get('admin-read').build({ url, adminToken: undefined }),
    /LOAD_ADMIN_TOKEN/,
  );
});

test('admin-read builds once a token is supplied', () => {
  const built = byName.get('admin-read').build({ url, adminToken: 'token' });
  assert.equal(typeof built.request, 'function');
});

test('money-movement scenarios refuse to run without seeded accounts', () => {
  for (const name of ['payment-confirmation', 'deposit-sweep']) {
    assert.throws(
      () => byName.get(name).build({ url, seededUsers: [] }),
      /seeded accounts/,
      name,
    );
  }
});

test('money-movement scenarios build once accounts exist', () => {
  const seededUsers = [{ phoneNumber: '+2348123400001', pin: '1234' }];
  for (const name of ['payment-confirmation', 'deposit-sweep']) {
    const built = byName.get(name).build({ url, seededUsers, appSecret: 's' });
    assert.equal(typeof built.request, 'function', name);
  }
});

test('scenarios with preconditions declare them in `requires`', () => {
  // `run.js` uses this to decide whether to seed before the measured phase.
  assert.deepEqual(byName.get('admin-read').requires, ['adminToken']);
  assert.deepEqual(byName.get('payment-confirmation').requires, ['seed']);
  assert.deepEqual(byName.get('deposit-sweep').requires, ['seed']);
});

test('scenarios without preconditions build from nothing but a URL', () => {
  for (const name of ['webhook-burst', 'sender-sequence', 'duplicate-storm', 'health-read']) {
    const built = byName.get(name).build({ url });
    assert.equal(typeof built.request, 'function', name);
  }
});

test('duplicate-storm exposes an invariant the runner can assert', () => {
  const built = byName.get('duplicate-storm').build({ url });
  assert.equal(typeof built.invariant, 'function');
});

test('every scenario has a name and a summary', () => {
  for (const scenario of SCENARIOS) {
    assert.ok(scenario.name, 'named');
    assert.ok(scenario.summary, `${scenario.name} has a summary`);
    assert.equal(typeof scenario.build, 'function', `${scenario.name} is buildable`);
  }
});
