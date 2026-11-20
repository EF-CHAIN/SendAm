'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');
const sep12 = require('../src/services/sep12.client');

const customerAccount = StellarSdk.Keypair.random().publicKey();
const anchorCustomers = new Map();
let lastAuthHeader = null;

const createMockSep12AnchorApp = () => {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    lastAuthHeader = req.headers.authorization || null;
    if (!lastAuthHeader || !lastAuthHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (lastAuthHeader === 'Bearer expired-jwt') {
      return res.status(401).json({ error: 'SEP-10 token expired' });
    }
    return next();
  });

  app.get('/customer', (req, res) => {
    const key = req.query.id || req.query.account;
    const customer = anchorCustomers.get(key);
    if (!customer) {
      return res.status(200).json({
        status: 'NEEDS_INFO',
        fields: {
          first_name: { type: 'string', description: 'First name' },
          last_name: { type: 'string', description: 'Last name' },
          id_type: { type: 'string', description: 'Government ID type' },
          id_number: { type: 'string', description: 'Government ID number' },
        },
      });
    }
    return res.status(200).json(customer);
  });

  app.put('/customer', (req, res) => {
    const body = req.body || {};
    if (!body.first_name || !body.last_name || !body.id_type || !body.id_number) {
      return res.status(400).json({ error: 'Missing required SEP-9 KYC fields' });
    }
    const customerId = body.id || `cust-${anchorCustomers.size + 1}`;
    const record = {
      id: customerId,
      status: 'ACCEPTED',
      provided_fields: {
        first_name: { type: 'string', status: 'VERIFIED' },
        last_name: { type: 'string', status: 'VERIFIED' },
        id_type: { type: 'string', status: 'VERIFIED' },
        id_number: { type: 'string', status: 'VERIFIED' },
      },
      submitted: body,
    };
    anchorCustomers.set(customerId, record);
    if (body.account) {
      anchorCustomers.set(body.account, record);
    }
    return res.status(202).json({ id: customerId, status: 'ACCEPTED' });
  });

  app.delete('/customer/:account', (req, res) => {
    anchorCustomers.delete(req.params.account);
    return res.status(200).json({ deleted: true });
  });

  return app;
};

const withAnchorServer = async (run) => {
  const server = http.createServer(createMockSep12AnchorApp());
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

beforeEach(() => {
  anchorCustomers.clear();
  lastAuthHeader = null;
});

describe('SEP-12 KYC API Client (#944)', () => {
  test('maps SendAm KycProfile fields (first name, last name, ID type, number, country, phone) to SEP-12 format', () => {
    const profile = {
      id: 'kyc-prof-1',
      userId: 'user-1',
      country: 'ng',
      status: 'approved',
      metadata: {
        applicant: {
          firstName: 'Adebayo',
          lastName: 'Okafor',
          idType: 'NIN',
          idNumber: '12345678901',
        },
        bankAccountNumber: '0123456789',
        bankCode: '058',
      },
    };
    const user = {
      id: 'user-1',
      phoneNumber: '+2348099990000',
      email: 'adebayo@sendam.io',
      publicKey: customerAccount,
    };

    const mapped = sep12.mapKycProfileToSep12(profile, user, { type: 'sep31-receiver' });

    assert.equal(mapped.first_name, 'Adebayo');
    assert.equal(mapped.last_name, 'Okafor');
    assert.equal(mapped.id_type, 'national_id');
    assert.equal(mapped.id_number, '12345678901');
    assert.equal(mapped.id_country_code, 'NG');
    assert.equal(mapped.address_country_code, 'NG');
    assert.equal(mapped.mobile_number, '+2348099990000');
    assert.equal(mapped.email_address, 'adebayo@sendam.io');
    assert.equal(mapped.bank_account_number, '0123456789');
    assert.equal(mapped.bank_number, '058');
    assert.equal(mapped.account, customerAccount);
    assert.equal(mapped.type, 'sep31-receiver');
  });

  test('normalizes regional African KYC ID types to SEP-9 standard identifiers', () => {
    assert.equal(sep12.mapIdTypeToSep9('BVN'), 'tax_id');
    assert.equal(sep12.mapIdTypeToSep9('NIN'), 'national_id');
    assert.equal(sep12.mapIdTypeToSep9('GHANA_CARD'), 'national_id');
    assert.equal(sep12.mapIdTypeToSep9('KENYA_ID'), 'national_id');
    assert.equal(sep12.mapIdTypeToSep9('PASSPORT'), 'passport');
    assert.equal(sep12.mapIdTypeToSep9('DRIVERS_LICENSE'), 'drivers_license');
    assert.equal(sep12.mapIdTypeToSep9('VOTER_ID'), 'voter_id');
  });

  test('queries customer status via GET /customer and submits KYC data via PUT /customer returning customer ID', async () => {
    await withAnchorServer(async (anchorUrl) => {
      const client = sep12.createSep12Client({ kycServerUrl: anchorUrl, jwt: 'valid-sep10-jwt' });

      // 1. Before submission, GET /customer returns NEEDS_INFO
      const initialStatus = await client.getCustomer({ account: customerAccount, type: 'sep24-withdraw' });
      assert.equal(initialStatus.status, 'NEEDS_INFO');
      assert.ok(initialStatus.fields.first_name);
      assert.equal(lastAuthHeader, 'Bearer valid-sep10-jwt');

      // 2. Submit SendAm KycProfile via submitKycProfile (PUT /customer)
      const updatedProfiles = [];
      const mockPrisma = {
        kycProfile: {
          update: async ({ where, data }) => {
            updatedProfiles.push({ where, data });
            return { id: where.id, ...data };
          },
        },
      };

      const profile = {
        id: 'kyc-profile-ng-1',
        country: 'NG',
        firstName: 'Ngozi',
        lastName: 'Eze',
        idType: 'BVN',
        idNumber: '22233344455',
        metadata: {},
      };
      const user = { id: 'user-ng-1', phoneNumber: '+2348012345678' };

      const submission = await sep12.submitKycProfile({
        kycServerUrl: anchorUrl,
        jwt: 'valid-sep10-jwt',
        profile,
        user,
        account: customerAccount,
        type: 'sep24-withdraw',
      }, { prisma: mockPrisma });

      assert.equal(submission.id, 'cust-1');
      assert.equal(submission.status, 'ACCEPTED');
      assert.equal(updatedProfiles.length, 1);
      assert.equal(updatedProfiles[0].data.metadata.sep12CustomerId, 'cust-1');

      // 3. Subsequent GET /customer returns ACCEPTED and customer ID
      const verifiedStatus = await client.getCustomer({ id: submission.id });
      assert.equal(verifiedStatus.id, 'cust-1');
      assert.equal(verifiedStatus.status, 'ACCEPTED');
      assert.equal(verifiedStatus.providedFields.id_number.status, 'VERIFIED');

      // 4. DELETE /customer/:account removes customer data
      const deleted = await client.deleteCustomer({ account: customerAccount });
      assert.equal(deleted.deleted, true);
    });
  });

  test('rejects missing required KYC fields, missing JWT, and handles upstream anchor errors', async () => {
    await withAnchorServer(async (anchorUrl) => {
      // Missing required KYC fields (e.g. missing id_number)
      await assert.rejects(
        () => sep12.putCustomer({
          kycServerUrl: anchorUrl,
          jwt: 'valid-sep10-jwt',
          profile: { firstName: 'Chidi', lastName: 'Nwosu', idType: 'NIN' },
        }),
        (err) => err instanceof sep12.Sep12Error
          && err.statusCode === 400
          && err.code === 'missing_required_kyc_fields',
      );

      // Missing SEP-10 JWT
      await assert.rejects(
        () => sep12.getCustomer({ kycServerUrl: anchorUrl, account: customerAccount }),
        (err) => err instanceof sep12.Sep12Error && err.statusCode === 401,
      );

      // Expired SEP-10 JWT rejected by anchor with 401
      await assert.rejects(
        () => sep12.getCustomer({ kycServerUrl: anchorUrl, jwt: 'expired-jwt', account: customerAccount }),
        (err) => err instanceof sep12.Sep12Error && err.statusCode === 401 && err.code === 'sep12_unauthorized',
      );
    });
  });
});
