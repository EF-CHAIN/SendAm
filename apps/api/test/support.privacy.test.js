const test = require('node:test');
const assert = require('node:assert/strict');
const { SupportPrivacyService, ACCESS_SCOPES } = require('../src/support/privacy.service');

const mockCustomer = {
  id: 'cust_001',
  name: 'Jane Doe',
  phone: '+2348012345678',
  email: 'jane.doe@example.com',
  walletAddress: 'GBC1234567890STELADDR',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00Z',
};

test('SupportPrivacyService - masks sensitive data by default (MINIMAL scope)', () => {
  const privacyService = new SupportPrivacyService();
  const result = privacyService.sanitizeCustomerData(mockCustomer, { scope: ACCESS_SCOPES.MINIMAL });

  assert.equal(result.phone, '+234****5678');
  assert.equal(result.email, 'j***@example.com');
  assert.equal(result.walletAddress, 'GBC1...ADDR');
  assert.equal(result.accessLevel, 'MINIMAL_MASKED');
});

test('SupportPrivacyService - exposes full data under PRIVILEGED scope and generates audit log', () => {
  const privacyService = new SupportPrivacyService();
  const agentContext = {
    agentId: 'agent_999',
    scope: ACCESS_SCOPES.PRIVILEGED,
    justification: 'Investigating missing transfer refund #882',
  };

  const result = privacyService.sanitizeCustomerData(mockCustomer, agentContext);

  assert.equal(result.phone, '+2348012345678');
  assert.equal(result.email, 'jane.doe@example.com');
  assert.equal(result.accessLevel, 'PRIVILEGED_FULL');

  const logs = privacyService.getAuditLogs({ agentId: 'agent_999' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].targetCustomerId, 'cust_001');
  assert.equal(logs[0].justification, 'Investigating missing transfer refund #882');
});
