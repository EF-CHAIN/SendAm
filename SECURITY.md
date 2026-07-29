# Security Policy

SendAm handles wallet keys and money movement, so we take security seriously even while the project is a Testnet MVP. This document explains how to report a vulnerability and summarizes the current security posture.

## Supported Status

SendAm is currently a **Stellar Testnet MVP**. It is not configured for real-money production use. Testnet XLM has no monetary value, but real user data (e.g. phone numbers) may be present, so please treat security issues with appropriate care.

## Reporting a Vulnerability

**Do not open a public issue for serious vulnerabilities**, including:

- Stellar secret key exposure or weaknesses in key encryption/handling.
- Authentication bypass (admin auth, webhook signature verification).
- Admin API route exposure.
- Transaction-signing or transfer-authorization vulnerabilities.
- Production credential or secret leaks.

Instead, report privately through **GitHub private vulnerability reporting**:

1. Go to <https://github.com/EF-CHAIN/SendAm/security/advisories/new> and fill
   in the advisory form. This keeps the details private to the maintainers
   until a fix is ready.

Please include when you can: affected component, reproduction steps, impact, and
any suggested fix. We aim to **acknowledge reports within 48 hours** and will
coordinate disclosure once a fix is available.

## Safe Harbor

We consider security research conducted in accordance with this policy to be:

- **Authorized** under applicable anti-hacking laws, and we will not initiate
  legal action against you for your research.
- **Exempt** from the DMCA, and you are not liable for circumvention of
  technology controls to the extent your activity is covered by this policy.
- **Helpful and conducted in good faith**, so we will work with you to resolve
  any issues before public disclosure.

We ask that you make a good-faith effort to avoid privacy violations,
destruction of data, and disruption of production services. Do not access or
modify data that does not belong to you, and stop testing and report immediately
once you have confirmed a vulnerability.

## Current Security Posture

Already in place:

- **Authenticated encryption & key versioning** of wallet secrets with AES-256-GCM (`v1:` version header format with support for key rotation and backward compatibility). No fallback key — a missing/invalid `ENCRYPTION_KEY` fails loudly at startup.
- **Admin authentication** via HMAC-signed, expiring session tokens. The API refuses to start without `ADMIN_PASSWORD` and `JWT_SECRET`; the login endpoint is rate-limited and all admin data routes require a valid Bearer token.
- **WhatsApp webhook signature verification** against the `X-Hub-Signature-256` header, fail-closed in production.
- **Idempotency** on inbound WhatsApp messages to prevent duplicate transfers from webhook retries.
- **Input validation** of Stellar public keys, amounts, and phone numbers on every surface.
- **Transfer guardrails**: per-transaction cap plus rolling 24h amount and count limits, with an upfront balance check.
- **Compliance review workflow**: KYC approval, sanctions screening, and custody review gates are now represented in the backend policy and persisted in `KycProfile`.
- **Audit logging** for wallet creation and payment execution is already present; the compliance workflow records review decisions and can be extended to log any manual approvals or denials.
- **CORS allowlist** enforced in production and **Mongo-backed rate limiting** shared across instances (per-IP REST, per-sender WhatsApp).
- The **unauthenticated REST wallet API** is disabled in production by default (`ENABLE_WALLET_REST_API`); WhatsApp is the signature-verified product surface.

## Compliance Assumptions and Threat Boundaries

- The repo is built for a **direct custody** model: user wallet secret keys are encrypted at rest, and all settlement happens through the server-side Stellar wallet adapter.
- The compliance workflow assumes an AML program with manual review gates for:
  - KYC status and tier-based transaction limits.
  - sanctions screening by destination country and cross-border transfers.
  - custody review statuses for accounts that require additional operational approval.
- The current implementation includes a **local sanctions screening baseline** for high-risk and blocked countries, but any production deployment must use a licensed sanctions screening provider and confirm the list with legal counsel.
- Operational ownership is split as follows:
  - **Compliance team**: KYC approvals, sanctions clearance, custody review decisions, and maintaining approved jurisdictions.
  - **Security team**: encryption key management, admin auth, audit logging, and endpoint hardening.
  - **Operations team**: production monitoring, database backups, and alerts for review queue growth or failed transfers.

## Known Limitations / Hardening Still Required

Before any real-money launch:

- Migrate from Stellar Testnet to mainnet with a vetted deployment.
- Replace the single static `ENCRYPTION_KEY` with managed key management (KMS/HSM) and key rotation.
- Add per-user authentication to the REST wallet API (or keep it disabled).
- Replace the single shared admin password with real admin accounts and roles.
- Add audit logging for sensitive actions, plus monitoring and alerting.
- Complete legal, compliance, KYC, AML, and custody review where required.

## Responsible Use During Development

- Use Stellar **Testnet** for development; never use real funds.
- Never commit secrets, private keys, access tokens, or `.env` files.
- Do not expose encrypted secret keys in API responses or logs.
