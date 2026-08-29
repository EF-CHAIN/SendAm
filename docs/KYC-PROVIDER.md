# Smile ID KYC lifecycle

SendAm uses Smile ID Basic KYC's asynchronous REST API. `POST
/api/compliance/kyc/start` creates a stable provider job ID, submits the
applicant to Smile ID, and returns `202`. Smile ID delivers its result to
`POST /api/compliance/kyc/callback/smileid`.

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
