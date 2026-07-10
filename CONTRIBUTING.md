# Contributing to SendAm

Thank you for your interest in contributing to SendAm. SendAm is an open-source WhatsApp-first Stellar payments MVP focused on making blockchain payments easier for mobile-first users.

Contributions are welcome across product, engineering, documentation, testing, security, and Stellar ecosystem integrations.

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Project Scope

SendAm currently focuses on:

- WhatsApp-based wallet commands.
- Stellar Testnet wallet creation.
- Native XLM balance checks.
- Native XLM transfers.
- Saved recipient aliases.
- Confirmation-based payment flow.
- Admin visibility for users, wallets, and transactions.

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
- Stellar asset support beyond native XLM.
- Contact and recipient management.
- QR-code wallet sharing.
- Compliance-aware production workflows.

## Local Setup

### Prerequisites

- Node.js 18 or newer.
- npm.
- MongoDB running locally or a MongoDB connection URI.
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

Avoid mixing unrelated changes in one pull request. For example, do not combine a UI redesign, backend auth changes, and README edits unless they are part of one clear feature.

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

## License

By contributing to SendAm, you agree that your contributions will be licensed under the MIT License.
