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

Instead, report privately through one of these channels:

1. **GitHub private vulnerability reporting (preferred):** open a report at
   <https://github.com/Gozirimdev/SendAm/security/advisories/new>. This keeps the
   details private to the maintainers until a fix is ready.
2. If you cannot use that, open a **minimal** public issue stating only that you
   found a security concern and asking for a private contact — do not post
   exploit details or proof-of-concept publicly.

> Maintainers: enable "Private vulnerability reporting" in the repository's
> Settings → Security so the link above is active, and add a direct email here
> if you have a dedicated security contact.

Please include, when you can: affected component, reproduction steps, impact, and any suggested fix. We aim to acknowledge reports promptly and will coordinate disclosure once a fix is available.

## Current Security Posture

Already in place:

- **Authenticated encryption** of wallet secrets with AES-256-GCM (tamper-detecting). No fallback key — a missing/invalid `ENCRYPTION_KEY` fails loudly at startup.
- **Admin authentication** via HMAC-signed, expiring session tokens. The API refuses to start without `ADMIN_PASSWORD` and `JWT_SECRET`; the login endpoint is rate-limited and all admin data routes require a valid Bearer token.
- **WhatsApp webhook signature verification** against the `X-Hub-Signature-256` header, fail-closed in production.
- **Idempotency** on inbound WhatsApp messages to prevent duplicate transfers from webhook retries.
- **Input validation** of Stellar public keys, amounts, and phone numbers on every surface.
- **Transfer guardrails**: per-transaction cap plus rolling 24h amount and count limits, with an upfront balance check.
- **CORS allowlist** enforced in production and **Mongo-backed rate limiting** shared across instances (per-IP REST, per-sender WhatsApp).
- The **unauthenticated REST wallet API** is disabled in production by default (`ENABLE_WALLET_REST_API`); WhatsApp is the signature-verified product surface.

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
