# SendAm completion backlog

Audit date: 2026-08-20  
Repository: `EF-CHAIN/SendAm`  
Audited revision: `8b13a56` (`main`)

This file is the evidence-backed backlog of work still incomplete on the audited revision. The former 45-item draft was removed because all of its titles had already been published as GitHub issues #89–#133. Six unfinished items were restrategized and republished as fresh, outcome-focused GitHub issues #147–#152; the older versions are closed as superseded.

## Validation summary

- `npm test`: 186 passed, 0 failed.
- `npm run lint`: API, landing, and admin passed.
- Local `main` matches `origin/main`.
- No frontend tests exist under `apps/admin` or `apps/landing`.
- No SEP-10 application implementation exists.
- Wallet encryption still relies on one static `ENCRYPTION_KEY`; no KMS/HSM integration or persisted key-version metadata exists.
- Admin login still relies on one shared `ADMIN_PASSWORD`; there is no per-admin identity and authorization flow.
- Project documentation contains stale and contradictory status claims.

## P0 — Security and launch blockers

### 1. Secure customer wallet and compliance APIs with SEP-10 sessions

**GitHub:** [#147](https://github.com/EF-CHAIN/SendAm/issues/147) — supersedes #90  
**Labels:** `difficulty: hard`, `security`, `authentication`, `stellar`, `backend`, `priority: critical`

#### Problem

Wallet and self-service compliance REST operations still identify users by a caller-supplied phone number and remain disabled in production behind `ENABLE_WALLET_REST_API`. There is no SEP-10 challenge creation or signed-challenge verification in the application.

#### Required work

- Define the user identity and threat model for REST and WhatsApp clients.
- Implement SEP-10 challenge creation, signature verification, expiration, single-use replay prevention, and home-domain/network validation.
- Issue short-lived application sessions bound to one user.
- Authorize wallet, PIN, and KYC operations from the authenticated identity instead of request phone numbers.
- Audit and rate-limit authentication attempts; document configuration and recovery.

#### Relevant files

- `apps/api/src/routes/wallet.routes.js`
- `apps/api/src/compliance/compliance.routes.js`
- `apps/api/src/middlewares/requireRestApiEnabled.js`
- `apps/api/src/config/env.js`
- `apps/api/src/wallet/stellar.adapter.js`
- `docs/STELLAR.md`

#### Acceptance criteria

- A caller cannot access another user's wallet, PIN, or KYC state by changing a phone number.
- SEP-10 challenge creation and validation work on the configured Stellar network.
- Expired, replayed, malformed, wrong-account, wrong-domain, and wrong-network challenges fail safely.
- Success and failure paths have automated tests and production documentation.

### 2. Move wallet encryption to versioned KMS envelope keys

**GitHub:** [#148](https://github.com/EF-CHAIN/SendAm/issues/148) — supersedes #91  
**Labels:** `difficulty: hard`, `security`, `wallet`, `storage`, `backend`, `priority: critical`

#### Problem

Ciphertext-format rotation exists, but production wallet secrets remain rooted in one process-level `ENCRYPTION_KEY`. Wallet records contain no key identifier/version, managed KMS/HSM boundary, or resumable operational rotation workflow.

#### Required work

- Adopt a managed KMS/HSM or approved envelope-encryption design.
- Persist a non-secret key identifier/version with each encrypted secret.
- Decrypt old versions while encrypting new writes with the active version.
- Add an idempotent, resumable, observable rotation command with dry-run and batching.
- Document access control, backup/restore, rollback, and compromise response.

#### Acceptance criteria

- Root-key operations use managed key infrastructure in production.
- Mixed key versions remain readable during rotation.
- Interrupted rotations resume without data loss or unreadable wallets.
- Tests cover mixed versions, retries, failure recovery, tampering, and secret redaction.

### 3. Replace shared admin login with auditable role-based accounts

**GitHub:** [#149](https://github.com/EF-CHAIN/SendAm/issues/149) — supersedes #96  
**Labels:** `difficulty: hard`, `security`, `admin`, `authentication`, `backend`, `priority: critical`

#### Problem

Every operator still authenticates with the shared `ADMIN_PASSWORD` and receives the same generic `admin` token. Existing role-related database models are not connected to individual identities, permissions, or session ownership.

#### Required work

- Implement individual admin identities using strong password hashing or an approved identity provider.
- Define least-privilege read-only, compliance, operations, and administrator roles.
- Enforce permissions server-side for every admin route and mutation.
- Add provisioning, disablement, credential reset, revocation, and last-admin safeguards.
- Attribute audit events to the actual administrator and migrate off the shared password safely.

#### Acceptance criteria

- Each administrator has an individual identity and revocable sessions.
- Roles are enforced by the API, including compliance mutations.
- Login, denial, role changes, revocation, and disablement are audit-visible and tested.

## P1 — Quality and maintainability

### 4. Protect the admin dashboard with automated user-flow tests

**GitHub:** [#150](https://github.com/EF-CHAIN/SendAm/issues/150) — supersedes #129  
**Labels:** `difficulty: medium`, `testing`, `frontend`, `admin`, `ci`

#### Problem

The admin app has lint and build checks but no test files or test script. Protected routing, session expiry, pagination, API errors, and KYC review mutations can regress without CI detection.

#### Required work

- Add a supported React/DOM test stack.
- Test login, protected redirects, logout/session expiry, pagination, loading, empty, and error states.
- Test KYC review confirmation, authorization failure, and API failure behavior.
- Mock the HTTP boundary and add the suite to root scripts and CI.

#### Acceptance criteria

- A documented root command runs admin tests and CI fails when they fail.
- Critical pages have deterministic success, empty, loading, and error coverage.
- Tests require no live API.

### 5. Add CI-enforced accessibility and interaction tests to the landing page

**GitHub:** [#151](https://github.com/EF-CHAIN/SendAm/issues/151) — supersedes #132  
**Labels:** `difficulty: medium`, `testing`, `frontend`, `landing`, `accessibility`, `ci`

#### Problem

The landing app has no test files or test script. Navigation, CTA destinations, FAQ behavior, keyboard access, and baseline accessibility are protected only by lint/build checks.

#### Required work

- Add smoke/component tests for core sections, navigation, CTAs, and FAQ behavior.
- Add automated accessibility checks for the home page and interactive components.
- Verify keyboard interaction, focus, landmarks, headings, labels, and reduced motion.
- Run everything in CI without live services.

#### Acceptance criteria

- A root command and CI run landing tests and accessibility checks.
- Primary CTAs use configured destinations and are tested.
- Navigation and FAQ are keyboard-operable with sensible focus behavior.
- Configured high-impact accessibility violations fail CI.

### 6. Make project status documentation verifiable and release-ready

**GitHub:** [#152](https://github.com/EF-CHAIN/SendAm/issues/152) — supersedes #133  
**Labels:** `difficulty: medium`, `documentation`, `audit`, `operations`

#### Problem

Documentation says only XLM is supported although the adapter supports USDC, calls the suite unit-only despite the webhook integration test, describes Mongo-backed rate limiting although PostgreSQL is used, and links changelog comparisons to the old repository owner. GitHub also leaves completed #33 and #48 open while incomplete issues are closed.

#### Required work

- Re-audit README, roadmap, architecture, security, API docs, changelog, and deployment docs against `main`.
- Separate “built,” “configured,” “deployed,” and “approved for real money.”
- Correct repository URLs and obsolete provider/infrastructure claims.
- Reconcile issue state using implementation and test evidence.
- Add an issue-closure checklist requiring acceptance-criteria evidence.

#### Acceptance criteria

- No known contradictions remain about assets, tests, rate limiting, auth, keys, deployment, or repository ownership.
- Every roadmap item links to code, deployment evidence, or an active issue.
- Completed #33 and #48 are closed; incomplete work stays open.

## P2 — Product behavior

### 7. Change the default send asset to USDC

**GitHub:** existing open #27  
**Labels:** `core`, `payments`, `stellar`

#### Problem

Commands without an asset default to XLM in intent parsing and payment orchestration. Product issue #27 requires USDC as the default while retaining explicit XLM sends.

#### Required work

- Default implicit sends to USDC in parsing and orchestration.
- Keep `send 5 xlm ...` on XLM.
- Ensure recipient wallets can receive USDC or get a clear recovery path.
- Update help, confirmation, receipt, and documentation copy.
- Add parser, orchestrator, and webhook-flow regression tests.

#### Acceptance criteria

- `send 5 <recipient>` uses USDC; `send 5 xlm <recipient>` uses XLM.
- Confirmation and receipts show the effective asset.
- Trustline failures do not create ambiguous or duplicate financial effects.

## GitHub issues ready to close

### #33 — Phone numbers as recipients

Implemented in `apps/api/src/whatsapp/recipientResolver.js`; `apps/api/test/recipientResolver.test.js` covers new numbers, existing numbers, and saved-contact precedence.

### #48 — Integration test: the full webhook flow

`apps/api/test/webhook.integration.test.js` covers the happy path, duplicate delivery, and concurrent PIN protection. It passes in the audited 186-test run.

## External production gates

Repository completion does not prove launch readiness. Before real-money use, retain release gates for verified API/worker deployment, production migration output, Meta webhook verification, production secrets/provider credentials, monitoring delivery tests, mainnet/corridor approval, and legal/compliance/custody sign-off.

## Additional implementation backlog (#153–#167)

The following issues were published after the initial audit. They are ordered by financial correctness and dependency risk rather than by GitHub issue number.

### 8. Use exact decimal arithmetic for payments, fees, quotes, and limits

**GitHub:** [#154](https://github.com/EF-CHAIN/SendAm/issues/154)  
**Labels:** `difficulty: hard`, `core`, `payments`, `pricing`, `compliance`, `priority: critical`

Replace JavaScript `Number` in financial paths with a single exact-decimal policy. Define asset precision and rounding rules, reject excessive precision before side effects, and test rounding and policy boundaries for XLM, USDC, and fiat currencies.

### 9. Make quote creation and payment reservation one atomic lifecycle

**GitHub:** [#155](https://github.com/EF-CHAIN/SendAm/issues/155)  
**Labels:** `difficulty: hard`, `payments`, `pricing`, `database`, `reliability`, `priority: critical`

Make quote persistence use the active Prisma transaction so quote and payment reservation commit or roll back together. Enforce quote ownership and expiry, define safe requoting, and test rollback, concurrency, and retry behavior against PostgreSQL.

### 10. Canonicalize customer phone numbers before identity lookup

**GitHub:** [#153](https://github.com/EF-CHAIN/SendAm/issues/153)  
**Labels:** `difficulty: hard`, `backend`, `validation`, `database`, `security`

Normalize every supported number to E.164 before identity lookup, storage, recipient resolution, messaging, or throttling. Provide collision-aware migration tooling so equivalent legacy formats cannot silently create or merge financial identities.

### 11. Make wallet provisioning safe under concurrent requests

**GitHub:** [#156](https://github.com/EF-CHAIN/SendAm/issues/156)  
**Labels:** `difficulty: hard`, `wallet`, `database`, `reliability`, `testing`

Make concurrent create-or-get requests return one wallet without unhandled unique conflicts or duplicate external work. Persist provisioning state and test concurrent user creation, wallet creation, funding, trustlines, and provider recovery with PostgreSQL.

### 12. Preserve per-customer WhatsApp message ordering in the worker queue

**GitHub:** [#157](https://github.com/EF-CHAIN/SendAm/issues/157)  
**Labels:** `difficulty: hard`, `whatsapp`, `queues`, `reliability`, `core`

Serialize messages per canonical sender while retaining concurrency across senders. Define delayed and out-of-order delivery behavior so PINs, cancellations, and payment commands cannot overtake the state transitions they depend on.

### 13. Deliver deposit alerts through a durable notification outbox

**GitHub:** [#158](https://github.com/EF-CHAIN/SendAm/issues/158)  
**Labels:** `difficulty: hard`, `notifications`, `reliability`, `database`, `stellar`

Atomically store Horizon cursor progress and notification intent, then deliver through an idempotent retryable worker. Failed alerts must be visible and replayable, with crash tests proving notifications are neither silently lost nor duplicated.

### 14. Automate database backup verification and disaster-recovery drills

**GitHub:** [#162](https://github.com/EF-CHAIN/SendAm/issues/162)  
**Labels:** `difficulty: hard`, `database`, `operations`, `reliability`, `deployment`

Define RPO/RTO and automate isolated restore verification for PostgreSQL, key access, and queue dependencies. Record drill results safely and alert when backups are stale or restores fail.

### 15. Implement customer data export, deletion, and retention workflows

**GitHub:** [#163](https://github.com/EF-CHAIN/SendAm/issues/163)  
**Labels:** `difficulty: hard`, `compliance`, `security`, `database`, `audit`

Create an approved data inventory and retention matrix, authenticated export/deletion requests, legal holds, safe anonymization, and retryable provider propagation. Preserve mandatory financial and audit records without retaining unnecessary personal data.

### 16. Support Stellar memos and muxed-account destinations safely

**GitHub:** [#164](https://github.com/EF-CHAIN/SendAm/issues/164)  
**Labels:** `difficulty: hard`, `stellar`, `payments`, `wallet`, `validation`

Support an explicit memo policy and muxed addresses across parsing, validation, transaction construction, confirmation, receipts, and auditing. Block determinable memo omissions and conflicting memo/muxed combinations before submission.

### 17. Track WhatsApp outbound delivery receipts and terminal failures

**GitHub:** [#159](https://github.com/EF-CHAIN/SendAm/issues/159)  
**Labels:** `difficulty: medium`, `whatsapp`, `notifications`, `webhook`, `observability`

Process Meta sent, delivered, read, and failed callbacks idempotently. Correlate provider IDs with internal messages, expose failure metrics and admin visibility, and test duplicate and out-of-order status events.

### 18. Harden voice-note ingestion with media limits and privacy controls

**GitHub:** [#160](https://github.com/EF-CHAIN/SendAm/issues/160)  
**Labels:** `difficulty: medium`, `voice`, `security`, `compliance`, `storage`

Validate voice MIME, size, duration, and download host; cap memory/time usage; and prevent empty or low-confidence transcripts from starting payments. Define consent, retention, deletion, and redaction rules for audio and transcripts.

### 19. Publish an OpenAPI contract for the supported REST API

**GitHub:** [#161](https://github.com/EF-CHAIN/SendAm/issues/161)  
**Labels:** `difficulty: medium`, `backend`, `documentation`, `validation`, `integration`

Create a versioned OpenAPI specification covering schemas, authentication, errors, pagination, examples, and feature gates. Validate the document and representative responses in CI and detect unintended breaking changes.

### 20. Add sandbox contract tests for Meta, Stellar, Smile ID, and pricing providers

**GitHub:** [#165](https://github.com/EF-CHAIN/SendAm/issues/165)  
**Labels:** `difficulty: medium`, `integration`, `testing`, `reliability`, `whatsapp`, `stellar`, `compliance`, `pricing`

Add protected scheduled/on-demand tests for provider request shapes, authentication, signatures, and sandbox behavior. Keep PR tests hermetic, prevent real-money usage, redact secrets/PII, and alert on provider API drift.

### 21. Add scalable filtering and cursor pagination to admin data APIs

**GitHub:** [#166](https://github.com/EF-CHAIN/SendAm/issues/166)  
**Labels:** `difficulty: medium`, `admin`, `backend`, `database`, `performance`

Replace inconsistent or unbounded admin listings with stable cursor pagination, indexed operational filters, URL-preserved UI state, and audited exports. Test traversal during concurrent inserts and invalid cursor handling.

### 22. Establish load tests and capacity limits for payment-critical paths

**GitHub:** [#167](https://github.com/EF-CHAIN/SendAm/issues/167)  
**Labels:** `difficulty: medium`, `performance`, `reliability`, `testing`, `observability`

Model webhook bursts, concurrent confirmations, deposits, queue load, database pools, and admin reads in an isolated environment. Track latency percentiles, throughput, errors, queue lag, and financial idempotency, then document capacity and scaling thresholds.
