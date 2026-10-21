# Smile ID KYC lifecycle

SendAm uses Smile ID Basic KYC's asynchronous REST API. `POST
/api/compliance/kyc/start` creates a stable provider job ID, submits the
applicant to Smile ID, and returns `202`. Smile ID delivers its result to
`POST /api/compliance/kyc/callback/smileid`.

## Sandbox setup

For local development and testing, contributors can configure the Smile ID sandbox environment without using real KYC documents or production secrets.

### 1. Obtain sandbox credentials

1. Sign up for a free developer account or log in to the [Smile ID Portal](https://portal.usesmileid.com/).
2. In the portal navigation, ensure the environment is toggled to **Sandbox** (test mode).
3. Navigate to **Developer Settings** > **API Keys** (or **Integration** > **API Keys**).
4. Note your **Partner ID** (numeric identifier) and generate/copy a **Sandbox API Key**.

### 2. Configure environment variables

In `apps/api/.env` (copied from `apps/api/.env.example`), configure the following variables:

```bash
# Set KYC provider to smileid
KYC_PROVIDER=smileid

# Your Smile ID sandbox Partner ID from the portal
SMILE_ID_PARTNER_ID=your_sandbox_partner_id

# Your Smile ID sandbox API key from the portal
SMILE_ID_API_KEY=your_sandbox_api_key

# Public HTTPS callback endpoint (must be accessible from the internet)
SMILE_ID_CALLBACK_URL=https://your-public-tunnel.ngrok-free.app/api/compliance/kyc/callback/smileid

# Optional: defaults to https://testapi.smileidentity.com/v2/verify_async when NODE_ENV is not production
SMILE_ID_BASE_URL=https://testapi.smileidentity.com/v2/verify_async

# Optional tuning (defaults: 10000ms timeout, 300s timestamp tolerance)
SMILE_ID_TIMEOUT_MS=10000
SMILE_ID_CALLBACK_TOLERANCE_SEC=300
```

> **Note**: Variable names must match `apps/api/.env.example` exactly. Never commit `.env` or real sandbox keys to source control.

### 3. Expose the callback endpoint locally

Smile ID delivers verification results asynchronously via HTTP POST to `SMILE_ID_CALLBACK_URL`. Because the callback must be an HTTPS URL reachable by Smile ID's servers:

1. Use an HTTPS tunneling service such as `ngrok` or Cloudflare Tunnel to expose your local API port (default `PORT=3002`):
   ```bash
   ngrok http 3002
   ```
2. Set `SMILE_ID_CALLBACK_URL` to your public tunnel HTTPS URL ending with the callback path:
   `https://<your-subdomain>.ngrok-free.app/api/compliance/kyc/callback/smileid`

### 4. Verify sandbox integration

1. Start the API in development mode:
   ```bash
   npm run dev:api
   ```
2. Trigger a KYC start via `POST /api/compliance/kyc/start` using test applicant data (refer to Smile ID's sandbox test personas).
3. Verify that:
   - The submission returns `202 Accepted` with a `jobId`.
   - The API logs `kyc_submission_accepted`.
   - When the webhook callback arrives at `/api/compliance/kyc/callback/smileid`, the signature validates and the API logs `kyc_callback_processed`.
4. Alternatively, run the credentialed contract suite:
   ```bash
   node --test apps/api/test/contract/smileid.sandbox.contract.test.js
   ```

## Configuration and rollout

Set `KYC_PROVIDER=smileid`, `SMILE_ID_PARTNER_ID`, `SMILE_ID_API_KEY`, and
`SMILE_ID_CALLBACK_URL`. The callback must be a public HTTPS URL. Development
defaults to Smile ID sandbox; production defaults to
`https://api.smileidentity.com/v2/verify_async`. Apply Prisma migrations before
deploying the API.

Roll out first with sandbox credentials and verify the `kyc_submission_accepted`
and `kyc_callback_processed` logs. Then use a new production-only API key,
change the callback in the Smile ID portal, deploy the production secrets, and
run one controlled verification. Restrict the callback at the edge to Smile
ID's published production IP ranges as defense in depth, but do not replace
signature verification with IP filtering.

The start request keeps the existing `phoneNumber` field and adds:
`country`, `idType`, `idNumber`, `firstName`, `lastName`, and optionally
`middleName`, `dob`, and `gender`. Supplying only the old, caller-selected
`providerReference` is intentionally no longer accepted: allowing a client to
claim provider initiation was the security flaw fixed by issue #97.

## Security and compliance boundaries

- SendAm authenticates every callback with Smile ID's HMAC-SHA256 signature,
  compares it in constant time, and rejects timestamps outside the configured
  replay window. A callback must also match both the stable job ID and internal
  user ID.
- The API sends identity fields directly to Smile ID and does not persist ID
  numbers, names, or dates of birth. Provider result metadata contains only
  result codes/text, job ID, and processing time. Application and provider logs
  must never include the request body or secrets.
- Smile ID makes the identity-match decision. Exact and partial matches
  (`1020`, `1021`) grant tier 1; no-match (`1022`) rejects; every other result
  requires manual review. Compliance owns changes to this policy and periodic
  API-key rotation.
- Platform Engineering owns secrets, HTTPS termination, IP allowlisting,
  migrations, availability, and alerting. Compliance Operations owns manual
  review and applicant recovery. Smile ID is outside SendAm's trust boundary;
  signed output is trusted only after the controls above pass.

## Idempotency, monitoring, and recovery

The provider job ID is deterministic per KYC profile. A repeated start while
pending returns the existing job without another provider request. Callback
processing uses a durable unique-event inbox and updates the KYC profile, user
tier, and audit record in one database transaction. Provider retries therefore
cannot replay a tier change or audit side effect.

Alert on:

- any `kyc_submission_failed` or sustained callback `401` responses;
- profiles in `pending` beyond the provider SLA;
- profiles in `review` with the operator-recovery reason;
- absence of `kyc_callback_processed` after accepted submissions.

For an accepted job with no callback, use the Smile ID portal to inspect/replay
the callback. A submission timeout is placed in `review`; retry the start
request after checking the portal. It reuses the same job ID. For a rejected
signature, verify clock synchronization and that the API key matches the Smile
ID environment before asking Smile ID to replay.

## Rollback

Rollback the API release while leaving the additive `KycWebhookEvent` table in
place; dropping it during an incident would discard deduplication history.
Disable new KYC starts at the ingress or REST feature gate, retain the callback
route until all in-flight jobs settle, and manually review pending profiles.
After recovery, redeploy, replay outstanding callbacks, and reconcile provider
jobs against KYC profiles and audit logs.
