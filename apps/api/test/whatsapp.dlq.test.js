'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

injectMock('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const {
  moveToDeadLetterQueue,
  listDeadLetterJobs,
  getDeadLetterJob,
  replayDeadLetterJob,
  clearDlq,
  sanitizePayload,
} = require('../src/queues/dlq.service');

beforeEach(async () => {
  await clearDlq();
});

test('moveToDeadLetterQueue stores exhausted job with failure reason and sanitized payload', async () => {
  const dummyJob = {
    id: 'job-101',
    name: 'processInboundMessage',
    attemptsMade: 3,
    data: {
      from: '+2348011112222',
      whatsappMessageId: 'wamid.HBgLMTIzNDU2Nzg5',
      text: 'Send 50 USDC to +2348000000000',
      pin: '1234', // sensitive field
    },
  };
  const error = new Error('Stellar Horizon node connection refused');

  const record = await moveToDeadLetterQueue(dummyJob, error, { queueName: 'whatsapp-inbound' });
  assert.ok(record.id.startsWith('dlq_'));
  assert.equal(record.originalJobId, 'job-101');
  assert.equal(record.queueName, 'whatsapp-inbound');
  assert.equal(record.status, 'pending');
  assert.equal(record.whatsappMessageId, 'wamid.HBgLMTIzNDU2Nzg5');
  assert.ok(record.failureReason.includes('Stellar Horizon node connection refused'));
  assert.equal(record.payload.pin, '[REDACTED]');
});

test('listDeadLetterJobs returns operator list with PII redacted', async () => {
  const dummyJob = {
    id: 'job-102',
    name: 'processInboundMessage',
    attemptsMade: 3,
    data: {
      from: '+2348012345678',
      whatsappMessageId: 'wamid.102',
      text: 'Secret phone: +2348012345678',
    },
  };
  await moveToDeadLetterQueue(dummyJob, new Error('Timeout'));

  const jobs = await listDeadLetterJobs({ status: 'pending' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id.includes('job-102'), true);
  assert.equal(jobs[0].payload.pin, undefined);
  assert.equal(jobs[0].sender.includes('2348012345678'), false); // phone redacted
});

test('replayDeadLetterJob prevents double payment if message is already completed in system', async () => {
  const dummyJob = {
    id: 'job-103',
    name: 'processInboundMessage',
    attemptsMade: 3,
    data: {
      from: '+2348099998888',
      whatsappMessageId: 'wamid.alreadyCompleted103',
    },
  };
  const record = await moveToDeadLetterQueue(dummyJob, new Error('Temporary glitch'));

  // Mock prisma processedMessage as completed
  const mockPrisma = {
    processedMessage: {
      findUnique: async () => ({ id: '1', messageId: 'wamid.alreadyCompleted103', status: 'completed' }),
    },
    auditLog: {
      create: async () => ({ id: 'audit-1' }),
    },
  };
  injectMock('common/prisma', mockPrisma);

  const mockQueueService = {
    enqueue: async () => {
      assert.fail('Should NOT re-enqueue an already completed message');
    },
  };

  const result = await replayDeadLetterJob(record.id, { queueService: mockQueueService });
  assert.equal(result.replayed, false);
  assert.equal(result.alreadyCompleted, true);
  assert.ok(result.reason.includes('already successfully processed'));
});

test('replayDeadLetterJob re-enqueues job and records audit event when job is valid', async () => {
  const dummyJob = {
    id: 'job-104',
    name: 'processInboundMessage',
    attemptsMade: 3,
    data: {
      from: '+2348077776666',
      whatsappMessageId: 'wamid.validToReplay104',
      text: 'hi',
    },
  };
  const record = await moveToDeadLetterQueue(dummyJob, new Error('Network failure'));

  let enqueued = false;
  let auditCreated = false;

  const mockQueueService = {
    enqueue: async (queue, jobName, data) => {
      enqueued = true;
      assert.equal(queue, 'whatsapp-inbound');
      assert.equal(data.isReplay, true);
      return { id: 'replayed-job-id' };
    },
  };

  const mockPrisma = {
    processedMessage: {
      findUnique: async () => null, // Not completed
    },
    auditLog: {
      create: async ({ data }) => {
        auditCreated = true;
        assert.equal(data.action, 'whatsapp.dlq.replayed');
        assert.equal(data.entityId, record.id);
        return { id: 'audit-2' };
      },
    },
  };
  injectMock('common/prisma', mockPrisma);

  const result = await replayDeadLetterJob(record.id, {
    queueService: mockQueueService,
    actorId: 'test-operator',
    actorType: 'operator',
  });

  assert.equal(result.replayed, true);
  assert.equal(enqueued, true);

  // Second replay attempt of same DLQ record is refused
  const retryResult = await replayDeadLetterJob(record.id, { queueService: mockQueueService });
  assert.equal(retryResult.replayed, false);
  assert.equal(retryResult.reason, 'Job has already been replayed.');
});

test('sanitizePayload masks secret keys and PII strings', () => {
  const input = {
    from: '+2348000000000',
    pin: '9999',
    token: 'bearer-secret-xyz',
    nested: { text: 'call +2348000000000' },
  };
  const sanitized = sanitizePayload(input);
  assert.equal(sanitized.pin, '[REDACTED]');
  assert.equal(sanitized.token, '[REDACTED]');
  assert.equal(sanitized.from.includes('2348000000000'), false);
});
