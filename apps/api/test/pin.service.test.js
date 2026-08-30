const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const loadPinService = (env = {}) => {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const configPath = require.resolve('../src/config/env');
  const pinServicePath = require.resolve('../src/compliance/pin.service');
  delete require.cache[configPath];
  delete require.cache[pinServicePath];

  const pinService = require('../src/compliance/pin.service');

  return {
    pinService,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete require.cache[configPath];
      delete require.cache[pinServicePath];
    },
  };
};

test('PIN hashing uses unique salts and versioned memory-hard output', () => {
  const { pinService, restore } = loadPinService({
    PIN_PEPPER: 'pepper-v1',
    PIN_PEPPER_VERSION: 'v1',
    PIN_PEPPER_VERSIONS: 'v1,v2',
    PIN_PEPPER_V1: 'pepper-v1',
    PIN_PEPPER_V2: 'pepper-v2',
  });

  try {
    const first = pinService.hashPin('1234');
    const second = pinService.hashPin('1234');

    assert.match(first, /^pin\$/);
    assert.match(first, /\$scrypt\$/);
    assert.notEqual(first, second);
    assert.equal(pinService.verifyPin('1234', first), true);
  } finally {
    restore();
  }
});

test('legacy HMAC hashes upgrade safely after successful verification', () => {
  const { pinService, restore } = loadPinService({
    PIN_PEPPER: 'pepper-v1',
    PIN_PEPPER_VERSION: 'v1',
    PIN_PEPPER_VERSIONS: 'v1,v2',
    PIN_PEPPER_V1: 'pepper-v1',
    PIN_PEPPER_V2: 'pepper-v2',
  });

  try {
    const legacyHash = crypto.createHmac('sha256', 'pepper-v1').update('1234').digest('hex');
    const result = pinService.verifyAndUpgradePin('1234', legacyHash);

    assert.equal(result.valid, true);
    assert.equal(result.upgraded, true);
    assert.match(result.hash, /^pin\$/);
    assert.equal(pinService.verifyPin('1234', result.hash), true);
    assert.equal(pinService.verifyPin('1234', legacyHash), true);
  } finally {
    restore();
  }
});

test('rotation supports old and new pepper versions and rejects tampered/unknown formats', () => {
  const { pinService, restore } = loadPinService({
    PIN_PEPPER: 'pepper-v2',
    PIN_PEPPER_VERSION: 'v2',
    PIN_PEPPER_VERSIONS: 'v1,v2',
    PIN_PEPPER_V1: 'pepper-v1',
    PIN_PEPPER_V2: 'pepper-v2',
  });

  try {
    const v1Legacy = crypto.createHmac('sha256', 'pepper-v1').update('1234').digest('hex');
    const v2Hash = pinService.hashPin('1234');

    assert.equal(pinService.verifyPin('1234', v1Legacy), true);
    assert.equal(pinService.verifyPin('1234', v2Hash), true);
    assert.equal(pinService.verifyPin('1234', 'pin$unknown$format'), false);
    assert.equal(pinService.verifyPin('1234', `${v2Hash.slice(0, -1)}0`), false);
  } finally {
    restore();
  }
});
