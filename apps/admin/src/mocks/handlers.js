import { http, HttpResponse } from 'msw';

export const handlers = [
  // Authentication
  http.post('*/api/admin/login', async ({ request }) => {
    const body = await request.json();
    if (body.password === 'correct_password') {
      return HttpResponse.json({ data: { token: 'fake_token' } });
    }
    return HttpResponse.json({ message: 'Invalid credentials' }, { status: 401 });
  }),

  // Current operator identity + permissions (server-authoritative RBAC).
  http.get('*/api/admin/me', () => {
    return HttpResponse.json({
      data: { id: 'admin-1', email: 'operator@example.com', name: 'Operator', role: 'administrator', permissions: ['*'], mustChangePassword: false },
    });
  }),

  // Self-serve password rotation; revokes other sessions server-side.
  http.post('*/api/admin/password', () => {
    return HttpResponse.json({ success: true, message: 'Password changed' });
  }),

  // Users
  http.get('*/api/admin/users', ({ request }) => {
    const url = new URL(request.url);
    const phone = url.searchParams.get('phone');
    if (phone === 'missing') {
      return HttpResponse.json({
        data: [],
        pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 0 },
      });
    }
    return HttpResponse.json({
      data: [{ _id: '1', phoneNumber: '+1234567890', createdAt: new Date().toISOString() }],
      pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 1 },
    });
  }),

  // Transactions
  http.get('*/api/admin/transactions', ({ request }) => {
    const url = new URL(request.url);
    const page = url.searchParams.get('page');
    const after = url.searchParams.get('after');

    if (page === '99') {
      return HttpResponse.json({ message: 'Server error' }, { status: 500 });
    }

    if (after) {
      return HttpResponse.json({
        data: [],
        pagination: { limit: 50, nextCursor: null, prevCursor: after, hasMore: false, total: 1 },
      });
    }

    return HttpResponse.json({
      data: [{ _id: 'tx1', type: 'deposit', amount: '100', asset: 'USDC', status: 'Completed', createdAt: new Date().toISOString() }],
      pagination: { limit: 50, nextCursor: 'cursor-page-2', prevCursor: null, hasMore: true, total: 1 },
    });
  }),

  // KYC
  http.get('*/api/admin/kyc', () => {
    return HttpResponse.json({
      data: [{ _id: 'kyc1', userId: { phoneNumber: '+1234567890' }, provider: 'Onfido', tier: 'Tier 1', riskScore: 'Low', status: 'pending', updatedAt: new Date().toISOString() }],
      pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 1 },
    });
  }),

  http.post('*/api/compliance/kyc/:id/review', () => {
    return HttpResponse.json({ success: true });
  }),

  // Audit logs
  http.get('*/api/admin/audit-logs', () => {
    return HttpResponse.json({
      data: [{ _id: 'a1', actorType: 'administrator', action: 'admin.login.succeeded', entityType: 'AdminSession', ipAddress: '127.0.0.1', createdAt: new Date().toISOString() }],
      pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 1 },
    });
  }),
];
