# Issue Closure Checklist

Use this template when closing a GitHub issue or merging a PR that resolves one.
Every acceptance criterion must be backed by evidence that is independently
verifiable — a claim without cited evidence does not satisfy the criterion.

## How to use this checklist

1. Copy the template below into the PR description or as a comment on the issue.
2. For each acceptance criterion in the issue, add a row to the Evidence table.
3. Link directly to the evidence (file path, test name, CI run, deployment URL,
   or commit SHA). Do not write "done" without a link.
4. If a criterion cannot be satisfied (blocked or out of scope), document the
   blocker explicitly and open a follow-up issue before closing.

---

## Closure Checklist Template

```markdown
## Issue closure checklist

Closes #<issue-number>

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | <copy from issue> | ✅ Done / ⏳ Deferred / ❌ Blocked | [link or N/A] |
| 2 | | | |

### Evidence summary

For each criterion marked Done, provide a one-sentence description of the
verifiable artifact and how to confirm it:

1. **Criterion 1** — Corrected in `ROADMAP.md` lines 12–18; confirmed by diffing
   the file or reading the "USDC / non-native asset support — Built" section.
2. **Criterion 2** — …

### Deferred / blocked items

If any criterion is deferred or blocked, explain here and link to the follow-up
issue that tracks it. Do not close the parent issue while a required criterion
is blocked without explicit maintainer sign-off.

### Testing

- [ ] Automated tests pass in CI (link to CI run).
- [ ] Manual smoke test performed (describe steps and expected/actual outcomes).
- [ ] No regressions in related tests.

### Documentation

- [ ] Relevant docs updated in the same PR (README, ROADMAP, SECURITY, CHANGELOG).
- [ ] All status labels in ROADMAP.md use the agreed vocabulary:
      Built / Configured / Deployed / Approved / Planned.

### Deployment / release (if applicable)

- [ ] Migration applied to target environment.
- [ ] Environment variables documented in `.env.example`.
- [ ] Health check confirms the service is running after deployment.
```

---

## Status vocabulary reference

| Status | Definition |
|--------|------------|
| **Built** | Code exists in this repo and is covered by automated tests. |
| **Configured** | Built, and all required environment / provider credentials are in place in production. |
| **Deployed** | Configured, and actually running on a reachable host handling real traffic. |
| **Approved** | Deployed, and any required legal, compliance, KYC/AML, or regulatory review has been completed for real-money operation. |
| **Planned** | Not started yet. |

Use these exact words in ROADMAP.md and PR/issue descriptions. "In progress",
"done", "complete", etc. are ambiguous — replace them with one of the above.

---

## Example: closing issue #152 (this issue)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | No known contradictions remain about assets, tests, rate limiting, auth, key management, deployment, or repo ownership | ✅ Done | See changes to `ROADMAP.md`, `SECURITY.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `README.md` in this PR |
| 2 | Every production-readiness statement uses the agreed status vocabulary | ✅ Done | `ROADMAP.md` now uses Built / Configured / Deployed / Approved / Planned throughout |
| 3 | Each roadmap item links to verifiable evidence or an active issue | ✅ Done | Code file links and test file links added to each ROADMAP.md section |
| 4 | Completed work is closed and unfinished acceptance criteria remain open | ✅ Done | USDC support marked Built with code links; per-user auth and mainnet remain Planned |
| 5 | Maintainers have a reusable closure/release checklist | ✅ Done | This file — `ISSUE_CLOSURE_CHECKLIST.md` |

---

## Guidance for reviewers

When reviewing a PR that closes an issue:

- Confirm that every criterion in the Evidence table has a clickable link.
- Check that any "Deferred" items have a linked follow-up issue.
- Verify that status labels in ROADMAP.md match the vocabulary table above.
- Run the test suite locally or confirm CI passed before approving.
