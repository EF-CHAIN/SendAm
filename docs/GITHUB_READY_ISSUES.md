# SendAm GitHub-ready issue backlog

This file captures the work that still needs to be completed before SendAm can be considered production-ready and release-safe. It is based on a review of the repository structure, app architecture, security posture, test coverage, and current backlog in the monorepo.

The issues below are written in a GitHub-ready format with problem statements, scope, technical work, affected files, and acceptance criteria so they can be copied directly into GitHub issues.

---

## Issue 1: Implement SEP-10 authentication for wallet and compliance REST APIs

Title: Secure wallet and compliance APIs with SEP-10 challenge validation

Problem:
SendAm exposes wallet and compliance-related REST APIs that currently depend on caller-supplied phone numbers instead of verified user identity. This is a security risk because a user can change a phone number parameter and reach another account. The application also lacks SEP-10 challenge creation and verification, so the API cannot authenticate a real Stellar account identity in a safe and standard way.

Scope:
- Define user identity and threat model for REST and WhatsApp clients.
- Implement SEP-10 challenge issuance and validation.
- Enforce user-scoped sessions for API calls.
- Remove direct reliance on phone-number parameters from authorization paths.
- Add monitoring and rejection of replay, expired, malformed, or mismatched challenges.

Affected areas:
- apps/api/src/routes/wallet.routes.js
- apps/api/src/routes/compliance.routes.js
- apps/api/src/middlewares/requireRestApiEnabled.js
- apps/api/src/config/env.js
- apps/api/src/wallet/stellar.adapter.js
- docs/STELLAR.md

Required work:
- Add challenge creation endpoints that issue signed challenge payloads for the configured network and home domain.
- Validate challenge signatures against the Stellar account, network passphrase, and domain.
- Enforce expiration and single-use replay protection.
- Bind session tokens or auth claims to the authenticated identity instead of raw phone numbers.
- Update wallet, PIN, and KYC endpoints to use authenticated identity rather than request data.
- Add rate limiting and audit logging for failed auth attempts.

Acceptance criteria:
- A caller cannot access another user’s wallet, PIN, or KYC record by altering a phone number.
- SEP-10 challenge issuance and verification work on the configured Stellar network.
- Expired, replayed, malformed, and wrong-account challenges fail safely.
- Automated tests cover valid flow and rejection cases.
- Production configuration, recovery, and rate-limit behavior are documented.

Labels:
security, backend, stellar, authentication, priority: critical

---

## Issue 2: Replace static wallet encryption with versioned KMS-backed key management

Title: Move wallet encryption to versioned KMS envelope keys

Problem:
Wallet secrets are still encrypted using a single static ENCRYPTION_KEY. There is no key versioning, no managed key lifecycle, and no rotation workflow that can be resumed safely. This creates operational risk and makes production secrets harder to rotate or recover during compromise or migration.

Scope:
- Introduce versioned envelope encryption for wallet secrets.
- Persist key identifier metadata with each encrypted secret.
- Support decryption of older encrypted versions during rotation.
- Add safe, resumable rotation logic.
- Document backup, rollback, and compromise response.

Affected areas:
- apps/api/src/wallet
- apps/api/src/config/env.js
- apps/api/src/services
- apps/api/prisma/schema.prisma
- docs/SECURITY.md or equivalent security docs

Required work:
- Replace the static process-level encryption design with a managed KMS/HSM or approved envelope-encryption model.
- Persist the key ID and version in wallet data.
- Allow reads of old versions while new writes use the active version.
- Add an executable rotation process with dry-run, batching, retries, and observable progress.
- Provide tamper detection and secret redaction in logs.

Acceptance criteria:
- Production encryption uses managed key infrastructure or an equivalent supported design.
- Mixed key versions remain readable during rotation.
- Rotation can resume without data loss or unreadable wallets.
- Tests cover mixed-version reads, retry behavior, rotation failures, tampering, and redaction.

Labels:
security, backend, wallet, storage, priority: critical

---

## Issue 3: Implement per-admin identity and role-based authorization

Title: Replace shared admin login with auditable role-based accounts

Problem:
The current admin authentication model uses one shared ADMIN_PASSWORD and one generic administrator token. There is no per-admin identity, no permission model, and no attribute-based auditing of who changed the system. This makes operational accountability impossible and creates a high-risk single point of failure.

Scope:
- Replace shared-secret admin access with per-user identities.
- Introduce role-based access control and least-privilege permissions.
- Ensure all admin mutations and read paths enforce authorization server-side.
- Add reset, revocation, and last-admin safeguards.

Affected areas:
- apps/api/src/admin
- apps/api/src/auth
- apps/api/src/middleware
- apps/api/prisma/schema.prisma
- apps/api/src/controllers

Required work:
- Add individual admin accounts with secure password hashing or SSO/OIDC integration.
- Define roles such as read-only, compliance, operations, and administrator.
- Enforce permissions on every admin route and state-changing action.
- Add audit logging that captures the acting admin identity.
- Add migration strategy to retire the shared ADMIN_PASSWORD safely.

Acceptance criteria:
- Each admin has a distinct account and revocable session.
- Roles are enforced across all admin endpoints.
- Login, denial, role-change, disablement, and revocation paths are audit-visible.
- The shared secret is retired without data loss for active administrators.

Labels:
security, admin, backend, authentication, priority: critical

---

## Issue 4: Add automated UI tests for the admin dashboard

Title: Protect the admin dashboard with automated user-flow tests

Problem:
The admin app has build and lint-level checks but no meaningful UI test coverage. This means login, protected routes, session expiry, pagination, loading states, and KYC review flows can regress without detection. There is no CI guard against broken admin workflows.

Scope:
- Add a supported test framework and test script to the admin app.
- Cover critical user flows and failure states.
- Add CI enforcement for the suite.

Affected areas:
- apps/admin
- package.json
- .github/workflows or CI config if present

Required work:
- Add React Testing Library or equivalent supported tooling to the admin app.
- Test login, redirect behavior, session expiry, logout, and protected pages.
- Cover pagination, API loading states, empty states, and error handling.
- Test KYC review confirmations and authorization failures.
- Run the suite without live backend dependencies by mocking HTTP boundaries.

Acceptance criteria:
- A root command runs admin tests.
- CI fails when key admin flows regress.
- Critical pages have deterministic empty, loading, and error coverage.
- No live API is required for the suite.

Labels:
testing, frontend, admin, ci, quality

---

## Issue 5: Add landing-page accessibility and interaction tests

Title: Add CI-enforced accessibility and interaction tests to the landing page

Problem:
The landing app has no real automated tests. This leaves navigation, CTA behavior, FAQ interactions, keyboard access, and accessibility regressions undetected. Current validation is limited to build and lint, which do not catch important user experience failures.

Scope:
- Add smoke tests for major sections and navigation.
- Add keyboard and accessibility checks.
- Run all checks in CI.

Affected areas:
- apps/landing
- package.json
- CI config

Required work:
- Add component and interaction tests for navigation, FAQ toggles, and primary CTAs.
- Include automated accessibility validation for the landing page.
- Verify focus management, keyboard interactivity, landmark structure, heading order, labels, and reduced-motion constraints.
- Add the test command to the repository root scripts and CI.

Acceptance criteria:
- Landing tests and accessibility checks run via a documented root command.
- Primary CTA destinations are covered by tests.
- Keyboard usage and focus behavior work for navigation and FAQ components.
- Accessibility violations fail CI when they exceed configured thresholds.

Labels:
testing, frontend, landing, accessibility, ci

---

## Issue 6: Reconcile project documentation with verified implementation status

Title: Make project status documentation verifiable and release-ready

Problem:
The project docs contain stale or contradictory statements about supported assets, environment assumptions, rate-limit storage, auth status, and deployment readiness. This creates confusion for engineers, investors, and operators and undermines trust in launch readiness.

Scope:
- Re-audit docs and project status against current code and test evidence.
- Separate built, configured, deployed, and approved-for-real-money status.
- Update stale repository and infrastructure claims.

Affected areas:
- README.md
- ROADMAP.md
- ARCHITECTURE.md
- docs/*
- CHANGELOG.md
- SECURITY.md

Required work:
- Verify each status claim against the current implementation and test suite.
- Correct asset support, auth, deployment, and infrastructure statements.
- Update stale repo references and ownership references.
- Add a release checklist that requires evidence before declaring a feature complete.
- Reconcile domain-specific claims like rate limiting, wallet encryption, and KYC support.

Acceptance criteria:
- No meaningful contradictions remain in the public project docs.
- Roadmap items are linked to code, deployment evidence, or issue tracking.
- Release status is separated into clearly defined maturity stages.
- The repository’s issue closure process requires acceptance-criteria evidence before closure.

Labels:
documentation, audit, operations, release-readiness

---

## Issue 7: Change the default send asset from XLM to USDC

Title: Change the default send asset to USDC

Problem:
The app currently defaults implicit sends to XLM in parsing and orchestration. Product expectations require USDC as the default asset while still supporting explicit XLM sends. The current behavior creates confusion in user flows and mismatches product intent.

Scope:
- Update parsing and orchestration defaults.
- Ensure explicit XLM sends still work.
- Update confirmations and receipts.
- Add regression tests.

Affected areas:
- apps/api/src/whatsapp or payment orchestration paths
- apps/api/src/wallet
- apps/api/test
- docs and help copy

Required work:
- Set the default asset to USDC for implicit send intents.
- Preserve explicit asset parsing such as send 5 xlm.<recipient> as XLM.
- Validate trustline handling and recovery behavior for USDC recipients.
- Update user-facing help, receipts, and documentation.

Acceptance criteria:
- send 5 <recipient> uses USDC by default.
- send 5 xlm <recipient> explicitly uses XLM.
- Confirmation and receipts display the effective asset consistently.
- Trustline failures do not create ambiguous or duplicate financial effects.

Labels:
core, payments, stellar, product

---

## Issue 8: Replace Number usage with exact decimal arithmetic in financial flows

Title: Use exact decimal arithmetic for payments, fees, quotes, and limits

Problem:
The application uses JavaScript Number in financial paths. This introduces floating-point precision bugs in fees, quote calculations, asset conversions, and compliance limits. This is especially risky in a financial product that handles balances, fees, and conversions across fiat and Stellar assets.

Scope:
- Standardize an exact-decimal policy across the project.
- Replace Number-based math in payment logic.
- Add validation and rounding rules.

Affected areas:
- payment logic
- pricing logic
- compliance limit calculations
- quote creation and reservation paths

Required work:
- Define a single exact-decimal policy for XLM, USDC, and fiat conversions.
- Reject excessive precision and invalid financial values before side effects occur.
- Standardize rounding behavior and currency precision rules.
- Add tests covering boundary values, rounding edge cases, and cross-asset conversions.

Acceptance criteria:
- No financial calculation relies on JavaScript Number without a precise-decimal wrapper or equivalent policy.
- Rounding and precision rules are explicit and tested.
- Price and fee computations remain deterministic under repeated runs.

Labels:
core, payments, pricing, compliance, priority: critical

---

## Issue 9: Make quote creation and payment reservation atomic

Title: Make quote creation and payment reservation one atomic lifecycle

Problem:
Quote creation and reservation are not guaranteed to commit as one atomic database workflow. This can lead to inconsistencies between stored quote state and payment or wallet reservation state, resulting in duplicate settlement work, stale quotes, or customer overbooking.

Scope:
- Ensure quote and reservation state are committed together.
- Enforce ownership and expiry rules.
- Add safe retry and concurrency handling.

Affected areas:
- Prisma transaction code
- payment orchestration
- quote persistence logic
- database tests

Required work:
- Wrap quote creation and reservation in a single Prisma transaction.
- Add quote ownership checks and expiry enforcement.
- Define safe re-quote and retry behavior.
- Add concurrency tests against PostgreSQL for races and rollback behavior.

Acceptance criteria:
- Quote creation and payment reservation either commit together or fail together.
- Concurrency tests confirm no duplicate or stale reservations are created.
- Retry logic does not produce inconsistent financial state.

Labels:
payments, pricing, database, reliability, priority: critical

---

## Issue 10: Canonicalize customer phone numbers before identity lookup

Title: Canonicalize customer phone numbers before identity lookup

Problem:
Customer phone numbers are processed in inconsistent formats, which can create duplicate identities, merge users incorrectly, or produce wrong matching behavior during identity lookup, recipient resolution, or throttling. This is a data-integrity and security issue with financial consequences.

Scope:
- Normalize all supported phone numbers to a canonical format before storing or using them.
- Support migration of existing inconsistent records.

Affected areas:
- customer identity logic
- recipient resolution
- messaging and throttling
- database migration scripts

Required work:
- Implement canonical E.164 normalization for all supported inputs.
- Use canonical numbers for user lookup, storage, contact resolution, queueing, and rate limiting.
- Add collision-aware migration tooling for existing data.
- Ensure equivalent legacy numbers cannot silently merge or split customers.

Acceptance criteria:
- All user and message processing uses canonical numbers.
- Legacy number variants are migrated without silent data collisions.
- Duplicate or conflicting records are detected and handled intentionally.

Labels:
backend, validation, database, security

---

## Issue 11: Make wallet provisioning safe under concurrent requests

Title: Make wallet provisioning safe under concurrent requests

Problem:
The project can receive concurrent create-or-get wallet requests for the same customer. Without safe concurrency handling, duplicate wallet creation, unique constraint conflicts, or unhandled external side effects can occur. This is especially important for real-money onboarding and wallet bootstrap flows.

Scope:
- Make wallet creation idempotent under race conditions.
- Persist provisioning state.
- Handle provider and trustline recovery correctly.

Affected areas:
- wallet creation service
- Prisma schema and queries
- provider integration and trustline setup
- test coverage

Required work:
- Add idempotent create-or-get logic for a user’s wallet.
- Handle unique violation retries and recovery flows gracefully.
- Ensure funding and trustline setup are not duplicated during concurrent requests.
- Add PostgreSQL-backed tests for concurrency and recovery.

Acceptance criteria:
- Concurrent requests return a single wallet record without duplicate provisioning.
- Unique conflicts are handled without unhandled exceptions.
- Funding and trustline setup are not duplicated or lost under retry conditions.

Labels:
wallet, database, reliability, testing

---

## Issue 12: Preserve WhatsApp message ordering per customer in the worker queue

Title: Preserve per-customer WhatsApp message ordering in the worker queue

Problem:
Messages from the same customer can be processed out of order by background workers. This risks PIN checks, cancellations, and payment commands being applied in the wrong order and causing state conflicts or financial misprocessing.

Scope:
- Serialize messages per canonical sender.
- Keep concurrency across unrelated senders.
- Define behavior for delayed and out-of-order messages.

Affected areas:
- queue configuration
- worker processors
- WhatsApp event handlers
- message state transitions

Required work:
- Ensure a single customer’s messages are processed serially while different customers remain concurrent.
- Define expected behavior for delayed or stale messages.
- Prevent messages that depend on state changes from overtaking the state transition they depend on.

Acceptance criteria:
- Messages from a single sender are processed in order.
- Different senders can still process concurrently.
- PIN and payment flows cannot silently overtake each other in unsafe ways.

Labels:
whatsapp, queues, reliability, core

---

## Issue 13: Deliver deposit alerts through a durable notification outbox

Title: Deliver deposit alerts through a durable notification outbox

Problem:
Deposit alerts are a critical customer communication path. If the API or worker process crashes while writing alert state, the notification may be lost or duplicated. This is especially risky for financial operations because customers must be notified reliably without silent gaps.

Scope:
- Make notification dispatch durable and retryable.
- Add idempotent delivery and replay support.
- Track Horizon cursor progress safely.

Affected areas:
- deposit alerting
- notification worker
- database storage
- Horizon polling or event processing

Required work:
- Store alert intent and cursor progress in a durable outbox pattern.
- Deliver notifications via an idempotent worker with explicit retry semantics.
- Add visibility and replay tooling for failed alerts.
- Add crash and replay tests to prove no silent loss or duplicate send.

Acceptance criteria:
- Failed notification jobs are visible and replayable.
- Alerts are either delivered once or retried deliberately without silent data loss.
- Crash testing confirms the alert system remains durable under failure scenarios.

Labels:
notifications, reliability, database, stellar

---

## Issue 14: Automate database backup verification and disaster-recovery drills

Title: Automate database backup verification and disaster-recovery drills

Problem:
The project relies on database backups and recovery workflows, but there is no automated protection to verify backup integrity or test restoration reliability. Without this, a real operational incident could result in data loss or a non-functional recovery process at the worst time.

Scope:
- Verify backup integrity and restore viability automatically.
- Document and test recovery drills.

Affected areas:
- database operations
- deployment docs
- backup automation
- operational runbooks

Required work:
- Add automated checks for backup completeness and validity.
- Run regular restore drills and document expected outcomes.
- Capture recovery objectives, rollback plans, and validation steps.
- Provide evidence and alerts when backups fail or drift.

Acceptance criteria:
- Backup verification runs automatically in validation or deployment workflows.
- Restore drills produce evidence of successful recovery.
- Operators can recover critical data within defined failure targets.

Labels:
database, operations, reliability, deployment

---

## Issue 15: Complete the remaining release gates for production launch

Title: Meet production launch gates before live-money deployment

Problem:
The codebase has made substantial progress, but it is not yet launch-ready for real-money use. The repository currently contains working modules and test evidence, but there remain provider, monitoring, compliance, operational, and custody requirements before production approval.

Scope:
- Confirm all deployment and security gates are met.
- Validate production provider configuration and monitoring.
- Confirm compliance and custody readiness.

Affected areas:
- deployment config
- provider credentials
- monitoring and alerts
- compliance workflows
- legal and operational readiness

Required work:
- Validate API and worker deployment against production requirements.
- Confirm a real production migration strategy and provider credentials are in place.
- Verify Meta webhook configuration and monitoring paths.
- Confirm custody procedures, compliance sign-off, and incident-response readiness.
- Require explicit operational evidence before live-money use.

Acceptance criteria:
- Production deployment is verified with smoke tests and monitoring.
- Live-money launch requires explicit sign-off from compliance, operations, and custody owners.
- No real-money flow starts without production verification and operational readiness criteria being met.

Labels:
production, compliance, deployment, operations, launch-gates

---

## Suggested GitHub issue creation prompt

Use this text when creating the issues in GitHub:

"Based on a repository audit of SendAm, please create the following GitHub issues with detailed problem statements, implementation scope, affected files, and acceptance criteria: SEP-10 secure wallet/compliance auth, versioned KMS wallet encryption, per-admin RBAC, admin UI tests, landing page a11y tests, documentation verification, USDC default send asset, exact decimal arithmetic, atomic quote reservation, canonical phone normalization, concurrent wallet provisioning, per-customer WhatsApp ordering, durable deposit notifications, backup verification drills, and production launch gates."

---

## Notes for implementation order

These issues should be handled in roughly this order:

1. Security and launch blockers
2. Reliability and compliance foundations
3. Test coverage and documentation
4. Product correctness and operational maturity

This order reflects the project’s financial-risk profile and the fact that the system currently includes meaningful backend logic but still lacks a secure and auditable operating model for production use.
