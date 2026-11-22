const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AnchorRegistry, ANCHOR_STATUS } = require('../src/services/anchorRegistry.service');
const { createAnchorMockServer } = require('./mocks/anchorServer');

test('AnchorRegistry checks GET /info and marks degraded anchors inactive', async () => {
  const mockAnchor = createAnchorMockServer();
  const baseUrl = await mockAnchor.start();

  try {
    const registry = new AnchorRegistry({ failureThreshold: 1 });
    registry.registerAnchor({
      id: 'primary-ngn',
      baseUrl,
      corridors: ['NGN:USDC'],
      priority: 10,
      rail: 'sep24',
    });

    const healthy = await registry.checkAnchorHealth('primary-ngn');
    assert.equal(healthy.status, ANCHOR_STATUS.ACTIVE);
    assert.equal(healthy.consecutiveFailures, 0);
    assert.equal(healthy.capabilities.sep24, true);

    mockAnchor.setHealthy(false);
    const failed = await registry.checkAnchorHealth('primary-ngn');
    assert.equal(failed.status, ANCHOR_STATUS.INACTIVE);
    assert.equal(failed.consecutiveFailures, 1);
    assert.ok(failed.lastError);
  } finally {
    await mockAnchor.stop();
  }
});

test('AnchorRegistry routes corridors away from inactive anchors to secondary anchor or fallback rail', async () => {
  const httpClient = {
    get: async (url) => {
      if (url.includes('anchor-a')) {
        throw new Error('ECONNREFUSED');
      }
      return { status: 200, data: { status: 'ok', capabilities: { sep31: true } } };
    },
  };

  const registry = new AnchorRegistry({ httpClient, failureThreshold: 1 });
  registry.registerAnchor({
    id: 'anchor-a',
    baseUrl: 'https://anchor-a.example',
    corridors: ['USD:NGN'],
    priority: 10,
    rail: 'sep31',
  });
  registry.registerAnchor({
    id: 'anchor-b',
    baseUrl: 'https://anchor-b.example',
    corridors: ['USD:NGN'],
    priority: 20,
    rail: 'sep24',
  });

  await registry.checkAllAnchors();

  assert.equal(registry.getAnchor('anchor-a').status, ANCHOR_STATUS.INACTIVE);
  assert.equal(registry.getAnchor('anchor-b').status, ANCHOR_STATUS.ACTIVE);

  const routed = registry.selectAnchorForPayment({ sourceAsset: 'USD', destinationAsset: 'NGN' });
  assert.equal(routed.available, true);
  assert.equal(routed.fallbackUsed, false);
  assert.equal(routed.anchor.id, 'anchor-b');
  assert.equal(routed.rail, 'sep24');

  // If secondary anchor also goes inactive, fall back to secondary rail
  registry.registerAnchor({
    id: 'anchor-b',
    baseUrl: 'https://anchor-b.example',
    corridors: ['USD:NGN'],
    priority: 20,
    rail: 'sep24',
    status: ANCHOR_STATUS.INACTIVE,
  });

  const fallback = registry.resolveCorridor('USD:NGN', { fallbackRail: 'stellar' });
  assert.equal(fallback.available, true);
  assert.equal(fallback.fallbackUsed, true);
  assert.equal(fallback.rail, 'stellar');
  assert.equal(fallback.reason, 'primary_anchors_inactive');

  // If no fallback rail is allowed, inform caller before payment attempt
  const unavailable = registry.resolveCorridor('USD:NGN', { fallbackRail: null });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, 'primary_anchors_inactive');
  assert.match(unavailable.message, /currently unavailable/i);
});
