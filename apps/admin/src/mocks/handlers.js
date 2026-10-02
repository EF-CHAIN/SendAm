import { http, HttpResponse } from "msw";

export const handlers = [
  // Authentication
  http.post("*/api/admin/login", async ({ request }) => {
    const body = await request.json();
    if (body.password === "correct_password") {
      return HttpResponse.json({ data: { token: "fake_token" } });
    }
    return HttpResponse.json(
      { message: "Invalid credentials" },
      { status: 401 },
    );
  }),

  // Authenticated operator identity + effective permissions
  http.get("*/api/admin/me", () => {
    return HttpResponse.json({ data: { permissions: ["*"] } });
  }),

  // Dashboard stats
  http.get("*/api/admin/stats", () => {
    return HttpResponse.json({
      data: {
        totalUsers: 42,
        totalWallets: 7,
        totalTransactions: 128,
        successfulTransactions: 100,
        failedTransactions: 8,
        pendingTransactions: 20,
        pendingKyc: 3,
        balances: [
          {
            asset: "USD",
            amount: "150.00",
            precision: 2,
            baseCurrency: "USD",
            baseAmount: "150.00",
            rate: "1",
            source: "identity",
          },
          {
            asset: "XLM",
            amount: "1000.0000000",
            precision: 7,
            baseCurrency: "USD",
            baseAmount: "500.00",
            rate: "0.5",
            source: "exchangerate-api",
          },
        ],
      },
    });
  }),

  // Users
  http.get("*/api/admin/users", ({ request }) => {
    const url = new URL(request.url);
    const phone = url.searchParams.get("phone");
    if (phone === "missing") {
      return HttpResponse.json({
        data: [],
        pagination: {
          limit: 50,
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
          total: 0,
        },
      });
    }
    return HttpResponse.json({
      data: [
        {
          _id: "1",
          phoneNumber: "+1234567890",
          createdAt: new Date().toISOString(),
        },
      ],
      pagination: {
        limit: 50,
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        total: 1,
      },
    });
  }),

  // Transactions
  http.get("*/api/admin/transactions", ({ request }) => {
    const url = new URL(request.url);
    const page = url.searchParams.get("page");
    const after = url.searchParams.get("after");

    if (page === "99") {
      return HttpResponse.json({ message: "Server error" }, { status: 500 });
    }

    if (after) {
      return HttpResponse.json({
        data: [],
        pagination: {
          limit: 50,
          nextCursor: null,
          prevCursor: after,
          hasMore: false,
          total: 1,
        },
      });
    }

    return HttpResponse.json({
      data: [
        {
          _id: "tx1",
          type: "deposit",
          amount: "100",
          asset: "USDC",
          status: "Completed",
          createdAt: new Date().toISOString(),
        },
      ],
      pagination: {
        limit: 50,
        nextCursor: "cursor-page-2",
        prevCursor: null,
        hasMore: true,
        total: 1,
      },
    });
  }),

  // Transaction detail
  http.get("*/api/admin/transactions/:id", ({ params }) => {
    return HttpResponse.json({
      data: {
        _id: params.id || "tx1",
        idempotencyKey: "idem-0001",
        txHash: "a".repeat(64),
        providerTransactionId: "prov-0001",
        explorerUrl: "https://stellar.expert/explorer/testnet/tx/abc",
        type: "deposit",
        amount: "100",
        asset: "USDC",
        fiatAmount: "100.00",
        fiatCurrency: "USD",
        rail: "stellar",
        routeType: "direct",
        destination: "+1234567890",
        recipientPhoneNumber: "+1999888777",
        userId: { id: "u1", phoneNumber: "+1234567890" },
        status: "Completed",
        createdAt: "2026-01-05T10:00:00.000Z",
        updatedAt: "2026-01-05T10:01:00.000Z",
        metadata: { rail: "stellar" },
      },
    });
  }),

  // Wallets
  http.get("*/api/admin/wallets", () => {
    return HttpResponse.json({
      data: [],
      pagination: {
        limit: 50,
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        total: 0,
      },
    });
  }),

  // WebAuthn / passkey step-up challenge for high-risk admin actions.
  http.post('*/api/admin/webauthn/step-up/challenge', async ({ request }) => {
    const body = await request.json().catch(() => ({}));
    return HttpResponse.json({
      data: {
        action: body.action || null,
        challenge: 'test-challenge-b64url',
        rpId: 'localhost',
        allowCredentials: [],
      },
    });
  }),

  // Customer account deactivation / reactivation (high-risk mutations)
  http.post('*/api/admin/users/:id/deactivate', () => {
    return HttpResponse.json({ data: { success: true } });
  }),

  http.post('*/api/admin/users/:id/reactivate', () => {
    return HttpResponse.json({ data: { success: true } });
  }),

  // Compliance evidence package download (high-risk export)
  http.get('*/api/admin/compliance/evidence/:id/download', () => {
    return HttpResponse.json({ data: { userId: '1', generatedAt: new Date().toISOString() } });
  }),

  // KYC
  http.get("*/api/admin/kyc", () => {
    return HttpResponse.json({
      data: [
        {
          _id: "kyc1",
          userId: { phoneNumber: "+1234567890" },
          provider: "Onfido",
          tier: "Tier 1",
          riskScore: "Low",
          status: "pending",
          updatedAt: new Date().toISOString(),
        },
      ],
      pagination: {
        limit: 50,
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        total: 1,
      },
    });
  }),

  http.get("*/api/admin/kyc/export", () => {
    const csvContent =
      "id,phoneNumber,provider,tier,status,country,riskScore,updatedAt\nkyc1,+1234567890,Onfido,Tier 1,pending,NG,Low,2026-09-26T12:00:00.000Z\n";
    return new HttpResponse(csvContent, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="kyc-export.csv"',
      },
    });
  }),

  http.post("*/api/compliance/kyc/:id/review", () => {
    return HttpResponse.json({ success: true });
  }),

  // System health
  http.get("*/api/admin/system-health", () => {
    return HttpResponse.json({
      data: { database: "ok", redis: "ok", horizon: "ok", queue: "ok" },
    });
  }),

  // Audit logs
  http.get("*/api/admin/audit-logs", () => {
    return HttpResponse.json({
      data: [
        {
          _id: "a1",
          actorType: "administrator",
          action: "admin.login.succeeded",
          entityType: "AdminSession",
          ipAddress: "127.0.0.1",
          createdAt: new Date().toISOString(),
        },
      ],
      pagination: {
        limit: 50,
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        total: 1,
      },
    });
  }),
];
