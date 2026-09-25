# MAINTAINER.md

This document describes the maintainer responsibilities, release process, and triage procedures for SendAm.

## Maintainer Responsibilities

- Review and merge pull requests
- Manage issue triage and labeling
- Coordinate releases
- Maintain CI/CD pipelines
- Ensure security updates are applied
- Monitor project health and dependencies

## Release Process

### Pre-Release Checklist

- [ ] All CI checks pass on `main` branch
- [ ] No critical or high-severity security vulnerabilities
- [ ] Changelog updated with notable changes
- [ ] Version bumped in `package.json` (root and all workspaces)
- [ ] Database migrations tested and documented (if applicable)
- [ ] Environment variables documented for new features
- [ ] Docker images build successfully
- [ ] Smoke tests pass on staging

### Release Steps

1. Create release branch: `git checkout -b release/vX.Y.Z`
2. Update version numbers in all `package.json` files
3. Update `CHANGELOG.md` with release notes
4. Commit changes: `chore: release vX.Y.Z`
5. Push branch and open PR to `main`
6. After PR approval and merge, tag release: `git tag vX.Y.Z && git push origin vX.Y.Z`
7. GitHub Actions will build and publish artifacts
8. Deploy to production (follow deployment runbook)
9. Verify production deployment
10. Close related issues and update project board

### Post-Release

- [ ] Monitor error rates and performance metrics for 24 hours
- [ ] Announce release in community channels
- [ ] Update documentation if needed
- [ ] Schedule next release planning

## Triage Process

### Issue Triage (Weekly)

1. **New Issues**: Review all new issues since last triage
2. **Labeling**: Apply appropriate labels:
   - `good first issue` - Well-scoped, self-contained
   - `help wanted` - Maintainers need input or are bandwidth-blocked
   - `core` - Core product work requiring deeper context
   - `docs` - Documentation-only changes
   - `ci` - CI/CD pipeline changes
   - `security` - Security-related (use private disclosure for vulns)
   - `bug` - Confirmed bug
   - `feature` - New feature request
3. **Prioritization**: Assign priority based on:
   - User impact
   - Security severity
   - Alignment with current milestone (M0-M3)
   - Maintainer bandwidth
4. **Assignment**: Assign to maintainer or leave open for community
5. **Stale Check**: Unassign issues with no activity for 2 weeks

### PR Triage (Daily)

1. **New PRs**: Review within 24 hours
2. **Checks**: Verify CI passes, tests included, lint passes
3. **Review Assignment**: Assign reviewer based on area expertise
4. **Approval**: Require at least one maintainer approval
5. **Merge**: Squash and merge after approval and CI pass

### Security Triage (Immediate)

1. Acknowledge report within 4 hours
2. Assess severity using CVSS
3. If critical/high: prepare hotfix within 24 hours
4. Coordinate disclosure timeline with reporter
5. Release patch version with fix

## Milestone Definitions

| Milestone | Focus Area |
|-----------|------------|
| M0 | Project scaffolding and local dev baseline |
| M1 | Testnet wallet and WhatsApp send/receive flow |
| M2 | Compliance, KYC, PIN, limits, audit logging |
| M3 | Community health, production hardening, ecosystem integrations |

## Label Taxonomy

| Label | Purpose |
|-------|---------|
| `core` | Core product work — wallet, payment, WhatsApp, compliance |
| `docs` | Documentation-only changes |
| `ci` | CI/CD pipeline changes |
| `good first issue` | Well-scoped, self-contained issues |
| `help wanted` | Maintainers want outside input |
| `M0`-`M3` | Milestone tracking |
| `security` | Security-related issues |
| `bug` | Confirmed bugs |
| `feature` | Feature requests |

## Emergency Procedures

### Hotfix Release

1. Create hotfix branch from latest release tag: `git checkout -b hotfix/vX.Y.Z vX.Y.Z`
2. Apply minimal fix
3. Run full test suite
4. Bump patch version
5. Fast-track review (single maintainer approval OK for critical fixes)
6. Tag and release
7. Cherry-pix to `main` if needed

### Rollback

1. Identify last known good release tag
2. Deploy that tag to production
3. Document incident and root cause
4. Create follow-up issue for permanent fix

## Contacts

- Primary maintainer: @EF-CHAIN/core-team
- Security reports: security@ef-chain.com (or private GitHub security advisory)
- Infrastructure: @EF-CHAIN/infra-team

## Useful Commands

```bash
# Run all tests
npm test

# Run frontend lint and build
npm run lint
npm run build:admin
npm run build:landing

# Check for security vulnerabilities
npm audit

# Update dependencies
npm update

# Secret scan
./scripts/secret-scan-self-test.sh
```