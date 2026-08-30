# Secret Scanning & Push Protection

SendAm uses [gitleaks](https://github.com/gitleaks/gitleaks) to detect credentials and private keys before they reach the default branch. This document covers what is scanned, how to handle detections, and the credential-rotation response process.

## What Is Scanned

The CI workflow (`.github/workflows/secret-scan.yml`) runs on every push and pull request to `main`. It uses the rules defined in `.gitleaks.toml` to detect:

| Category | Examples |
| --- | --- |
| Stellar secret keys | `S...` (56-char base-32 seeds) |
| Stellar seed phrases | 12/24-word mnemonic phrases |
| Database URLs with passwords | `postgresql://user:password@host` |
| Redis URLs with passwords | `redis://:password@host` |
| JWT secrets | `JWT_SECRET=<real value>` |
| Encryption keys | `ENCRYPTION_KEY=<hex>` |
| Generic API keys / secrets | `API_KEY=...`, `SECRET_KEY=...`, `TOKEN=...` |
| PEM private keys | `-----BEGIN PRIVATE KEY-----` |
| AWS secret keys | `AWS_SECRET_ACCESS_KEY=...` |
| WhatsApp / Meta tokens | `WHATSAPP_TOKEN=...` |

### What Is Allowed

The following are intentionally excluded from scanning:

- `node_modules/`, `dist/`, `build/`, `coverage/`, `.next/` — build artifacts
- `.env.example` and `.env.local.example` — documented placeholders
- `package-lock.json` — lockfile noise
- Markdown docs (`*.md`) — documentation references
- Template string placeholders: `${VAR}`, `$(VAR)`, `<VAR>`

## How the CI Workflow Works

The workflow has two jobs:

### 1. Gitleaks Self-Test

Creates a temporary file containing seeded fake secrets (a fake Stellar key, database URL, API key, etc.) and runs gitleaks against it. Asserts that gitleaks **detects** them (exit code 1). If gitleaks passes (exit 0), the self-test fails — proving the scanner is working on every CI run.

### 2. Gitleaks Scan

Runs `gitleaks/gitleaks-action@v2` against the full repository history using `.gitleaks.toml`. Any detection fails the check and blocks the PR.

## Running the Self-Test Locally

Before pushing, contributors can verify the scanner works:

```bash
./scripts/secret-scan-self-test.sh
```

This requires gitleaks to be installed locally:

```bash
# macOS
brew install gitleaks

# Go
go install github.com/gitleaks/gitleaks/v8@latest

# Docker
docker pull ghcr.io/gitleaks/gitleaks:latest
```

## False-Positive Review

If gitleaks flags something that is not a real secret (a test fixture, a documentation example, a placeholder value), follow these steps:

### 1. Confirm It Is a False Positive

Ask yourself:
- Is this value actually used as a credential anywhere?
- Could this value be extracted and used to access a real service?
- Is this a test fixture or documentation example?

If the answer is "no, this is safe," proceed to step 2.

### 2. Add an Allowlist Entry

Edit `.gitleaks.toml` and add a targeted allowlist. Prefer the most specific option:

**Allowlist a specific path:**
```toml
[[allowlists]]
description = "Test fixture — fake credentials"
paths = [
  '''tests/secret-scan/fixtures/''',
]
```

**Allowlist a specific regex pattern:**
```tomools
[[allowlists]]
description = "Known test placeholder values"
regexes = [
  '''TEST_PUBLIC_KEY_FOR_MOCK''',
  '''postgresql://localhost:5432/test''',
]
```

**Allowlist a specific commit (last resort):**
```toml
[[allowlists]]
description = "Known false positive in PR #123"
commits = ["abc123def456..."]
```

### 3. Verify the Fix

Run the full scan locally to confirm the false positive is resolved:

```bash
gitleaks detect --source=. --config=.gitleaks.toml --verbose
```

### 4. Document the Change

Mention the allowlist addition in your PR description so maintainers can review it.

## Credential Rotation Response

If gitleaks detects what appears to be a **real** credential, follow this response process immediately:

### Step 1: Do Not Merge

Do not merge the PR containing the detected secret. Leave a comment on the PR indicating a credential was detected.

### Step 2: Determine Scope

Check if the credential was already pushed to `main`:
- If the PR is not yet merged, the secret is only in the feature branch — rotate anyway as a precaution.
- If the secret was previously on `main`, treat it as a full exposure.

### Step 3: Rotate the Credential

For each type of credential:

| Credential Type | Rotation Steps |
| --- | --- |
| **Stellar secret key** | Generate a new keypair. Fund the new account on testnet. Update `ENCRYPTION_KEY` and re-encrypt the wallet. |
| **Database password** | Rotate the database password. Update `DATABASE_URL` in all environments. |
| **JWT_SECRET** | Generate a new secret (`openssl rand -hex 32`). Update all environments. Existing sessions will be invalidated. |
| **ENCRYPTION_KEY** | Generate a new key (`openssl rand -hex 32`). Re-encrypt all wallet secret keys with the new key. |
| **API keys** (provider) | Regenerate the key in the provider's dashboard. Update the environment variable. |
| **Redis password** | Rotate the Redis password. Update `REDIS_URL`. |
| **WhatsApp tokens** | Regenerate in Meta Business Suite. Update `WHATSAPP_TOKEN` and `WHATSAPP_APP_SECRET`. |

### Step 4: Remove the Secret from Git History

If the secret was pushed to `main`, it must be removed from git history:

```bash
# Option 1: git filter-branch (rewrite history)
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch <file-with-secret>' \
  --prune-empty --tag-name-filter cat -- --all

# Option 2: BFG Repo-Cleaner (faster, recommended)
bfg --delete-files <filename>
git reflog expire --expire=now --all && git gc --prune=now --aggressive
```

Then force-push and notify all collaborators to re-clone or reset.

### Step 5: Audit Access

Check provider logs and database audit trails for unauthorized access using the leaked credential. Report any suspicious activity.

### Step 6: Update the PR

After rotation, remove the secret from the PR, push the fix, and re-run CI.

## Pre-Push Hook (Optional)

For local enforcement before pushing, install a pre-push hook:

```bash
cat > .git/hooks/pre-push << 'HOOK'
#!/usr/bin/env bash
# Run gitleaks before pushing.
if command -v gitleaks &>/dev/null; then
  gitleaks protect --staged --config=.gitleaks.toml --no-banner
  if [ $? -ne 0 ]; then
    echo "Push blocked: gitleaks detected secrets in staged changes."
    echo "Review the findings and fix before pushing."
    exit 1
  fi
fi
HOOK
chmod +x .git/hooks/pre-push
```

## References

- [gitleaks documentation](https://github.com/gitleaks/gitleaks/blob/main/docs/)
- [GitHub push protection](https://docs.github.com/en/code-security/secret-scanning/using-advanced-secret-scanning-features)
- [SECURITY.md](../SECURITY.md) — vulnerability reporting and security posture
