#!/usr/bin/env bash
# secret-scan-self-test.sh — Validate that gitleaks catches seeded fake secrets.
#
# Usage:
#   ./scripts/secret-scan-self-test.sh
#
# Exit codes:
#   0 — self-test passed (gitleaks caught the fake secrets)
#   1 — self-test failed (gitleaks did NOT catch the fake secrets, or gitleaks is missing)
#
# This script does NOT modify any tracked files. It creates a temporary directory
# that is deleted on exit.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

info()  { echo -e "${YELLOW}[info]${NC}  $*"; }
pass()  { echo -e "${GREEN}[pass]${NC}  $*"; }
fail()  { echo -e "${RED}[fail]${NC}  $*"; }

# ── Check gitleaks is installed ───────────────────────────────────────────────

if ! command -v gitleaks &>/dev/null; then
  fail "gitleaks is not installed."
  echo ""
  echo "  Install it:"
  echo "    brew install gitleaks          (macOS)"
  echo "    go install github.com/gitleaks/gitleaks/v8@latest"
  echo "    docker pull ghcr.io/gitleaks/gitleaks:latest"
  echo ""
  echo "  Or download from: https://github.com/gitleaks/gitleaks/releases"
  exit 1
fi

info "gitleaks version: $(gitleaks version 2>/dev/null || echo 'unknown')"

# ── Create temporary directory with seeded fake secrets ───────────────────────

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/fake-secrets.env" <<'SECRETS'
# Seeded fake secrets — proves gitleaks catches real patterns.
# These are NOT real credentials. Used only by the self-test.
          STELLAR_SECRET_KEY=SAAAAFAKESECRETABC234567DEFGHIJKLMNO234567PQRSTUVWXYZ234
DATABASE_URL=postgresql://sendam:hunter2_real_password@db.example.com:5432/sendam
API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456
JWT_SECRET=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3
REDIS_URL=redis://:super_secret_redis_pass@redis.example.com:6379
ENCRYPTION_KEY=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
SECRETS

info "Created seeded fake secrets in $TMPDIR/fake-secrets.env"

# ── Run gitleaks against the temporary file ───────────────────────────────────

info "Running gitleaks detect..."
set +e
OUTPUT="$(gitleaks detect --source="$TMPDIR" --no-banner --redact 2>&1)"
EXIT_CODE=$?
set -e

if [ "$EXIT_CODE" -eq 1 ]; then
  pass "gitleaks correctly detected seeded fake secrets (exit code 1)"
  echo ""
  echo "  Detection output (redacted):"
  echo "$OUTPUT" | head -20
  echo ""
  pass "Self-test PASSED"
  exit 0
else
  fail "gitleaks did NOT detect the seeded fake secrets (exit code: $EXIT_CODE)"
  echo ""
  echo "  Output:"
  echo "$OUTPUT"
  echo ""
  fail "Self-test FAILED — gitleaks rules may need updating"
  exit 1
fi
