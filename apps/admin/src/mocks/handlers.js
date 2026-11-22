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

  // Session lifecycle & password rotation
  http.post("*/api/admin/logout", () => {
    return HttpResponse.json({ success: true });
  }),

  http.post("*/api/admin/session/renew", () => {
    return HttpResponse.json({ data: { token: "renewed_fake_token" } });
  }),

  http.post("*/api/admin/password", () => {
    return HttpResponse.json({ success: true });
  }),

  // Single-user drill-down, onboarding status & account status history
  http.get("*/api/admin/users/:id", ({ params }) => {
    return HttpResponse.json({
      data: {
        _id: params.id || "1",
        id: params.id || "1",
        phoneNumber: "+1234567890",
        status: "active",
        kycTier: 1,
        createdAt: "2026-01-05T10:00:00.000Z",
        updatedAt: "2026-01-05T10:00:00.000Z",
      },
    });
  }),

  http.get("*/api/admin/users/:id/onboarding", ({ params }) => {
    return HttpResponse.json({
      data: {
        userId: params.id || "1",
        stage: "in_progress",
        percentComplete: 67,
        checkpoints: [
          { id: "account_created", label: "Account created", complete: true },
          { id: "wallet_ready", label: "Wallet ready", complete: true },
          { id: "kyc_approved", label: "Identity verified", complete: false },
        ],
      },
    });
  }),

  http.get("*/api/admin/users/:id/account-status", ({ params }) => {
    return HttpResponse.json({
      data: [
        {
          _id: "status-1",
          userId: params.id || "1",
          status: "active",
          reason: "Initial activation",
          createdAt: "2026-01-05T10:00:00.000Z",
        },
      ],
    });
  }),

  // Single-wallet drill-down
  http.get("*/api/admin/wallets/:id", ({ params }) => {
    return HttpResponse.json({
      data: {
        _id: params.id || "w1",
        publicKey: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGOROTMPGQW5BCW5AZ",
        network: "testnet",
        funded: true,
        trustlineState: "succeeded",
        balances: [
          { asset: "XLM", amount: "100.0000000" },
          { asset: "USDC", amount: "250.00" },
        ],
        createdAt: "2026-01-05T10:00:00.000Z",
      },
    });
  }),

  // Sensitive field reveal
  http.post("*/api/admin/reveal/:resource/:id", ({ params }) => {
    return HttpResponse.json({
      data: {
        resource: params.resource,
        id: params.id,
        revealed: true,
        phoneNumber: "+1234567890",
      },
    });
  }),

  // CSV exports
  http.get("*/api/admin/transactions/export", () => {
    const csv = "id,type,amount,asset,status,createdAt\ntx1,deposit,100,USDC,Completed,2026-01-05T10:00:00.000Z\n";
    return new HttpResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="transactions-export.csv"',
      },
    });
  }),

  http.get("*/api/admin/audit-logs/export", () => {
    const csv = "id,actorType,action,entityType,ipAddress,createdAt\na1,administrator,admin.login.succeeded,AdminSession,127.0.0.1,2026-01-05T10:00:00.000Z\n";
    return new HttpResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="audit-logs-export.csv"',
      },
    });
  }),

  // Workflow events & ledger integrity
  http.get("*/api/admin/events", () => {
    return HttpResponse.json({
      data: [
        {
          _id: "evt-1",
          eventType: "transfer.settled",
          entityId: "tx1",
          hash: "b".repeat(64),
          createdAt: "2026-01-05T10:00:00.000Z",
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

  http.get("*/api/admin/events/verify", () => {
    return HttpResponse.json({
      data: { valid: true, checkedCount: 1, brokenAt: null },
    });
  }),

  http.get("*/api/admin/events/export", () => {
    const csv = "id,eventType,entityId,createdAt\nevt-1,transfer.settled,tx1,2026-01-05T10:00:00.000Z\n";
    return new HttpResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="workflow-events-export.csv"',
      },
    });
  }),

  // Compliance evidence packages & exports
  http.get("*/api/admin/compliance/evidence/:id", ({ params }) => {
    return HttpResponse.json({
      data: {
        userId: params.id || "1",
        generatedAt: "2026-01-05T10:00:00.000Z",
        kycRecords: [],
        accountStatusHistory: [],
      },
    });
  }),

  http.get("*/api/admin/compliance/kyc-evidence/export", () => {
    const csv = "id,userId,status,createdAt\nkyc1,1,pending,2026-01-05T10:00:00.000Z\n";
    return new HttpResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="kyc-evidence-export.csv"',
      },
    });
  }),

  http.get("*/api/admin/compliance/account-status/export", () => {
    const csv = "id,userId,status,reason,createdAt\nstatus-1,1,active,Initial activation,2026-01-05T10:00:00.000Z\n";
    return new HttpResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="account-status-export.csv"',
      },
    });
  }),
];
