//# Contributing to SendAm

Thank you for your interest in contributing to SendAm. SendAm is an open-source WhatsApp-first payments MVP (Stellar, direct-custody wallets) focused on making blockchain payments easier for mobile-first users.

Contributions are welcome across product, engineering, documentation, testing, security, and Stellar ecosystem integrations.

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Project Scope

SendAm currently focuses on:

- WhatsApp-based wallet commands.
- Direct-custody wallet creation on Stellar (testnet).
- Native-asset balance checks and transfers (XLM).
- Saved recipient aliases, with optional global-name resolution via the
  private naming service.
- Confirmation-based payment flow (PIN + policy guardrails).
- Admin visibility for users, wallets, and transactions.

### Open territory

Areas that are deliberately open and where contributions have the most
leverage:

- **Chain adapters** — new chains behind the `apps/api/src/wallet/`
  adapter interface (validate/create/balance/send + explorer URLs).
- **Localization** — reply copy lives in `apps/api/src/services/agent/replies.js`;
  Pidgin/Yoruba/Igbo/Hausa copy and locale plumbing are wide open.
- **WhatsApp UX** — richer command handling, better error copy, receipts,
  interactive flows.
- **Integration tests** — the suite is offline unit tests today; a
  container-backed integration harness (Postgres + queue) would be valuable.
- **Admin dashboard** — usability, filtering, and reporting improvements.

Before contributing a large feature, please open an issue first so we can discuss scope and avoid duplicate work.

## Ways To Contribute

Good first areas include:

- Improve WhatsApp command handling.
- Add tests for parser, wallet, webhook, and transaction flows.
- Improve frontend accessibility and responsiveness.
- Add clearer API documentation.
- Improve input validation for Stellar addresses, amounts, and phone numbers.
- Add transaction receipt and explorer improvements.
- Improve admin dashboard usability.
- Add deployment and environment setup docs.
- Review security assumptions around wallet custody and key handling.

Larger areas include:

- Per-user authentication for the REST wallet API.
- Managed secret/key management (KMS/HSM) and key rotation.
- Audit logging, monitoring, and alerting.
- Asset support beyond chain-native assets (ERC-20, Stellar anchor assets).
- Contact and recipient management.
- QR-code wallet sharing.
- Compliance-aware production workflows.

## Local Setup

### Prerequisites

- Node.js 20 or newer (see `.nvmrc`).
- npm.
- A PostgreSQL database for `DATABASE_URL` — not needed just to run the unit
  tests, which are fully offline. Run `docker compose up -d` from the repo
  root for a local Postgres with no cloud account required (see the root
  [`README.md`](README.md#local-postgres-no-cloud-account-needed)); a cloud
  database (e.g. Neon) also works.
- Stellar Testnet configuration.
- WhatsApp Business Cloud API credentials if testing webhooks.

### Install Dependencies

From the repository root:

```bash
npm install
```

### Configure Environment Variables

Create `apps/api/.env` from `apps/api/.env.example`.

Create `apps/admin/.env` and `apps/landing/.env` (see the root `README.md`
"Environment Variables" section for the `VITE_*` values each app expects).

Do not commit real secrets, production keys, access tokens, private keys, or `.env` files.

### Run The Backend

```bash
npm run dev:api
```

The backend runs on:

```text
http://localhost:3002
```

### Run The Frontend

The frontend is two Vite + React apps, `landing` and `admin`:

```bash
npm run dev:landing   # http://localhost:3000
npm run dev:admin     # http://localhost:3001
```

Or run everything (API + both apps) at once:

```bash
npm run dev
```

## Development Workflow

1. Fork the repository.
2. Create a feature branch from `main`.
3. Make focused changes.
4. Run relevant checks.
5. Open a pull request with a clear description.

Recommended branch naming:

```text
feature/add-contact-aliases
fix/webhook-validation
docs/update-api-readme
test/parser-commands
```

## Pull Request Guidelines

Please keep pull requests focused. A good pull request should include:

- What changed.
- Why it changed.
- How to test it.
- Screenshots or demo notes for UI changes.
- Any new environment variables.
- Any security or data-model implications.

- Avoid mixing unrelated changes in one pull request. For example, do not combine a UI redesign, backend auth changes, and README edits unless they are part of one clear feature.

### Tests are required

Every PR must include tests for any new or changed code. PRs without tests will be closed unreviewed.

The test suite uses plain `node:test`. See `apps/api/test/` for example test files you can copy.

Also, the 2-implementation-files-per-PR scoping rule applies (see above).


## Code Style

General expectations:

- Follow the existing JavaScript and React style.
- Keep changes simple and readable.
- Prefer clear function names.
- Avoid unnecessary abstractions.
- Do not commit generated build output.
- Do not commit `node_modules`.
- Do not commit secrets or private keys.

Backend expectations:

- Keep controllers focused on request handling.
- Put reusable business logic in services.
- Validate user input before using it in Stellar or database operations.
- Return consistent API responses.
- Do not expose encrypted secret keys in API responses.

Frontend expectations:

- Keep UI components accessible.
- Avoid hardcoded production-only URLs where env variables are better.
- Keep tables and forms usable on smaller screens.
- Use existing Tailwind conventions.

## Checks Before Submitting

For backend changes, run the test suite (built-in Node test runner):

```bash
npm test                            # from the repo root
npm run test --workspace=apps/api   # equivalently
```

Backend syntax checks:

```bash
node --check apps/api/src/server.js
node --check apps/api/src/app.js
```

If your change touches a specific backend file, run `node --check` on that file too. New parser, crypto, auth, or transaction logic should come with tests in `apps/api/test/`.

For frontend changes, lint and build the app(s) you touched:

```bash
npm run lint  --workspace=apps/landing
npm run build --workspace=apps/landing
npm run lint  --workspace=apps/admin
npm run build --workspace=apps/admin
```

These same checks run automatically in CI (`.github/workflows/ci.yml`) on every pull request.

## Security Policy

See [`SECURITY.md`](SECURITY.md) for the full reporting process and current security posture.

Do not open public issues for serious security vulnerabilities involving:

- Secret key exposure.
- Encryption weaknesses.
- Authentication bypass.
- Admin route exposure.
- Transaction-signing vulnerabilities.
- Production credential leaks.

Instead, contact the maintainers privately if a security contact is available. If not, open a minimal issue saying you found a security concern and avoid posting exploit details publicly.

## Stellar-Specific Contribution Notes

When contributing Stellar functionality:

- Use Stellar Testnet for development.
- Do not use real funds in development.
- Validate public keys before submitting transactions.
- Store transaction hashes when payments are submitted.
- Include Stellar Expert links where useful.
- Be careful with custody-related changes.
- Document any assumptions around assets, issuers, trustlines, or anchors.

## Documentation Contributions

Documentation improvements are highly valued. Good documentation makes SendAm easier to review, fund, deploy, and extend.

Useful docs contributions include:

- Better setup instructions.
- API examples.
- WhatsApp command examples.
- Deployment guides.
- Architecture diagrams.
- Security and compliance notes.
- Stellar integration explanations.

## Labels and Triage

### Label Taxonomy

Every issue and pull request is tagged with one or more labels. The full set:

| Label | Purpose |
|---|---|
| `core` | Core product work — wallet, payment, WhatsApp, compliance, voice flows. Requires deeper context. |
| `docs` | Documentation-only changes — README, CONTRIBUTING, guides, inline comments. |
| `ci` | CI/CD pipeline changes — GitHub Actions workflows, build scripts, lint, test runner config. |
| `good first issue` | Well-scoped, self-contained issues with clear done criteria. Ideal for first-time contributors. |
| `help wanted` | Maintainers want outside input or are blocked on bandwidth. Open to anyone regardless of experience level. |
| `M0` | Milestone 0 — project scaffolding and local dev baseline. |
| `M1` | Milestone 1 — testnet wallet and WhatsApp send/receive flow. |
| `M2` | Milestone 2 — compliance, KYC, PIN, limits, and audit logging. |
| `M3` | Milestone 3 — community health, production hardening, and ecosystem integrations. |

> **Maintainer action required:** The labels above must be created in the GitHub repository settings before they appear on issues. Go to **Issues → Labels → New label** for each entry in the table.

### Triage Flow

1. **Find an issue.** Browse open issues filtered by `good first issue` or `help wanted`. Read the description and done criteria fully before claiming.

2. **Claim by comment.** Leave a comment on the issue saying you are working on it — for example: _"I'd like to take this one."_ A maintainer will assign it to you. Do not open a pull request without first claiming the issue.

3. **One issue at a time.** Please work on one issue at a time. Finish or release your current claim before picking up another.

4. **Stale claims.** If there is no visible progress (no draft PR, no update comment) within **two weeks** of being assigned, the issue will be unassigned and reopened for others. If you need more time, leave a short comment on the issue — that resets the clock.

5. **Releasing a claim.** If you can no longer work on an issue, comment to let the maintainers know so it can be reassigned quickly. No explanation needed.

## License

By contributing to SendAm, you agree that your contributions will be licensed under the MIT License.
