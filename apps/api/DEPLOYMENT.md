# Deployment Manifests

SendAm requires a signed deployment manifest for every production release. The manifest captures the environment configuration at deploy time, and its HMAC-SHA256 signature guarantees the manifest has not been tampered with between signing and promotion.

## Why

Untrusted or drifting configuration is a leading cause of production incidents. A signed manifest makes every config change auditable, ties promotions to an approved artifact, and gives operators a deterministic way to verify that what is running matches what was reviewed.

## Concepts

| Term | Meaning |
|---|---|
| **Manifest** | JSON document produced by `scripts/generate-deployment-manifest.js` at build/deploy time. |
| **Config hash** | SHA-256 digest of the normalized environment values included in the manifest. |
| **Signature** | HMAC-SHA256 over the manifest payload using `MANIFEST_SIGNING_SECRET`. |
| **Verified** | The API server has confirmed the signature, the manifest is approved, and it has not expired. |

## Workflow

### 1. Prepare the signing secret

Store `MANIFEST_SIGNING_SECRET` in your secret store (e.g. Vault, AWS Secrets Manager, or your CI environment). The same secret must be available to:
- The CI job that signs the manifest.
- The API server at startup (`MANIFEST_MANIFEST_SECRET`).

Generate a secret:
```bash
openssl rand -hex 32
```

### 2. Generate the manifest

```bash
MANIFEST_SIGNING_SECRET=<your-secret> node apps/api/scripts/generate-deployment-manifest.js \
  --environment production \
  --release <git-sha-or-version> \
  --output apps/api/deployment-manifest.json \
  --signed-by "ops-oncall"
```

### 3. Commit the manifest to the release artifact

Include `deployment-manifest.json` in your release artifact (Docker image layer, S3 bundle, etc.). Do **not** commit the signing secret.

### 4. Configure the API server

```bash
DEPLOYMENT_MANIFEST_PATH=/app/deployment-manifest.json
DEPLOYMENT_MANIFEST_SECRET=<same-secret-as-above>
```

### 5. Verify on startup

`server.js` calls `validateEnv(config)` which delegates to `validateManifestAtStartup()`. If verification fails, the process exits before accepting traffic.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `DEPLOYMENT_MANIFEST_PATH` | Production | Absolute path to the signed `deployment-manifest.json`. |
| `DEPLOYMENT_MANIFEST_SECRET` | Production | HMAC secret used to verify the manifest signature. |
| `MANIFEST_SIGNING_SECRET` | CI only | HMAC secret used to sign manifests during CI. |

## Manifest schema

```json
{
  "version": "1.0",
  "environment": "production",
  "release": "abc1234",
  "generatedAt": "2026-08-29T12:00:00.000Z",
  "configHash": "sha256:<hex>",
  "config": { "NODE_ENV": "production", ... },
  "approved": true,
  "approvedBy": "ops-oncall",
  "checksums": { "sha256": "<hex>" },
  "signature": {
    "algorithm": "hmac-sha256",
    "value": "<hmac-hex>",
    "signedAt": "2026-08-29T12:00:00.000Z"
  }
}
```

## Config diff detection

On startup, the server:
1. Reads the manifest.
2. Re-computes the config hash from the current environment.
3. Fails if the current hash differs from the manifest hash.

This surfaces config drift before any traffic is accepted.

## Rotation and expiry

Signatures are valid for 24 hours from `signedAt`. Re-sign and redeploy after that window. For longer-lived releases, re-generate the manifest from the same approved config and re-sign.

## Audit trail

Every startup verification is logged. Failures are reported via `captureException` and the process exits with code 1.
