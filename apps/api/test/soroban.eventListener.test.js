'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  parseScValToJs,
  buildEventFilters,
  parseContractEvent,
  matchesEventFilter,
  createSorobanEventListener,
  DEFAULT_NOTIFICATION_QUEUE,
} = require('../src/blockchain/eventListener');

describe('Soroban Event Subscription Daemon (#933)', () => {
  test('parseScValToJs converts ScVal symbols, strings, numbers, maps, and vectors to native JavaScript objects', () => {
    const symVal = StellarSdk.xdr.ScVal.scvSymbol('escrow_funded');
    assert.equal(parseScValToJs(symVal), 'escrow_funded');
    assert.equal(parseScValToJs(symVal.toXDR('base64')), 'escrow_funded');

    const mapVal = StellarSdk.xdr.ScVal.scvMap([
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('amount'),
        val: StellarSdk.nativeToScVal(5000, { type: 'u64' }),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('currency'),
        val: StellarSdk.xdr.ScVal.scvString('NGN'),
      }),
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol('verified'),
        val: StellarSdk.xdr.ScVal.scvBool(true),
      }),
    ]);

    const parsedObj = parseScValToJs(mapVal.toXDR('base64'));
    assert.deepEqual(parsedObj, {
      amount: 5000,
      currency: 'NGN',
      verified: true,
    });
  });

  test('buildEventFilters constructs contractId and encoded topic filters for getEvents', () => {
    const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 9));
    const filters = buildEventFilters({
      contractIds: [contractId],
      topics: [['escrow', 'funded', '*']],
    });

    assert.equal(filters.length, 1);
    assert.equal(filters[0].type, 'contract');
    assert.deepEqual(filters[0].contractIds, [contractId]);
    assert.equal(filters[0].topics.length, 1);
    assert.equal(filters[0].topics[0][2], '*');
  });

  test('parseContractEvent and matchesEventFilter accurately decode and filter contract events', () => {
    const contractA = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 10));
    const contractB = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 11));

    const rawEvent = {
      id: '0000010500-0001',
      type: 'contract',
      ledger: 10500,
      ledgerClosedAt: '2026-11-19T15:00:00Z',
      contractId: new StellarSdk.Contract(contractA),
      pagingToken: '0000010500-0001',
      txHash: 'c'.repeat(64),
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('escrow'),
        StellarSdk.xdr.ScVal.scvSymbol('funded'),
      ],
      value: StellarSdk.xdr.ScVal.scvMap([
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('escrowId'),
          val: StellarSdk.xdr.ScVal.scvString('esc-99'),
        }),
        new StellarSdk.xdr.ScMapEntry({
          key: StellarSdk.xdr.ScVal.scvSymbol('amount'),
          val: StellarSdk.nativeToScVal(25000, { type: 'i128' }),
        }),
      ]),
    };

    const parsed = parseContractEvent(rawEvent);
    assert.equal(parsed.contractId, contractA);
    assert.deepEqual(parsed.topics, ['escrow', 'funded']);
    assert.deepEqual(parsed.data, { escrowId: 'esc-99', amount: 25000 });

    assert.equal(
      matchesEventFilter(parsed, { contractIds: [contractA], topics: [['escrow', 'funded']] }),
      true,
    );
    assert.equal(
      matchesEventFilter(parsed, { contractIds: [contractA], topics: [['escrow', '*']] }),
      true,
    );
    assert.equal(
      matchesEventFilter(parsed, { contractIds: [contractB], topics: [['escrow', 'funded']] }),
      false,
    );
    assert.equal(
      matchesEventFilter(parsed, { contractIds: [contractA], topics: [['attestation', 'updated']] }),
      false,
    );
  });

  test('createSorobanEventListener captures events, deduplicates, advances cursor, and dispatches to BullMQ queue', async () => {
    const targetContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 12));
    const otherContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 13));

    const dispatchedJobs = [];
    const getEventsRequests = [];

    const mockRpcClient = {
      getLatestLedger: async () => ({ sequence: 2000 }),
      getEvents: async (req) => {
        getEventsRequests.push(req);
        return {
          latestLedger: 2005,
          events: [
            {
              id: 'evt-1',
              pagingToken: 'cursor-1',
              ledger: 2001,
              contractId: targetContractId,
              topic: [
                StellarSdk.xdr.ScVal.scvSymbol('escrow').toXDR('base64'),
                StellarSdk.xdr.ScVal.scvSymbol('funded').toXDR('base64'),
              ],
              value: StellarSdk.xdr.ScVal.scvMap([
                new StellarSdk.xdr.ScMapEntry({
                  key: StellarSdk.xdr.ScVal.scvSymbol('recipientPhone'),
                  val: StellarSdk.xdr.ScVal.scvString('+2348012345678'),
                }),
                new StellarSdk.xdr.ScMapEntry({
                  key: StellarSdk.xdr.ScVal.scvSymbol('amount'),
                  val: StellarSdk.nativeToScVal(15000, { type: 'u64' }),
                }),
              ]).toXDR('base64'),
            },
            {
              // Event from another contract should be filtered out
              id: 'evt-2',
              pagingToken: 'cursor-2',
              ledger: 2002,
              contractId: otherContractId,
              topic: [
                StellarSdk.xdr.ScVal.scvSymbol('escrow').toXDR('base64'),
                StellarSdk.xdr.ScVal.scvSymbol('funded').toXDR('base64'),
              ],
              value: StellarSdk.xdr.ScVal.scvString('ignored').toXDR('base64'),
            },
            {
              id: 'evt-3',
              pagingToken: 'cursor-3',
              ledger: 2003,
              contractId: targetContractId,
              topic: [
                StellarSdk.xdr.ScVal.scvSymbol('attestation').toXDR('base64'),
                StellarSdk.xdr.ScVal.scvSymbol('updated').toXDR('base64'),
              ],
              value: StellarSdk.xdr.ScVal.scvMap([
                new StellarSdk.xdr.ScMapEntry({
                  key: StellarSdk.xdr.ScVal.scvSymbol('status'),
                  val: StellarSdk.xdr.ScVal.scvString('verified'),
                }),
              ]).toXDR('base64'),
            },
          ],
        };
      },
    };

    const listener = createSorobanEventListener({
      rpcClient: mockRpcClient,
      contractIds: [targetContractId],
      topics: [
        ['escrow', 'funded'],
        ['attestation', 'updated'],
      ],
      pollIntervalMs: 1000,
      dispatch: async (queueName, jobName, payload, opts) => {
        dispatchedJobs.push({ queueName, jobName, payload, opts });
      },
    });

    const firstPoll = await listener.pollOnce();
    assert.equal(firstPoll.processed, 2);
    assert.equal(dispatchedJobs.length, 2);

    assert.equal(dispatchedJobs[0].queueName, DEFAULT_NOTIFICATION_QUEUE);
    assert.equal(dispatchedJobs[0].jobName, 'soroban.escrow.funded');
    assert.deepEqual(dispatchedJobs[0].payload.data, {
      recipientPhone: '+2348012345678',
      amount: 15000,
    });
    assert.equal(dispatchedJobs[0].opts.jobId, 'soroban-evt-evt-1');

    assert.equal(dispatchedJobs[1].jobName, 'soroban.attestation.updated');
    assert.deepEqual(dispatchedJobs[1].payload.data, {
      status: 'verified',
    });

    // Second poll with same events must deduplicate and use cursor pagination
    const secondPoll = await listener.pollOnce();
    assert.equal(secondPoll.processed, 0);
    assert.equal(dispatchedJobs.length, 2);
    assert.equal(getEventsRequests[1].pagination.cursor, 'cursor-3');
    assert.equal(listener.getState().cursor, 'cursor-3');
  });

  test('start and stop manage background polling lifecycle cleanly within 5-second window', () => {
    const listener = createSorobanEventListener({
      rpcClient: {
        getLatestLedger: async () => ({ sequence: 100 }),
        getEvents: async () => ({ latestLedger: 100, events: [] }),
      },
      pollIntervalMs: 1500,
    });

    listener.start();
    assert.equal(listener.getState().isRunning, true);

    listener.stop();
    assert.equal(listener.getState().isRunning, false);
  });
});
