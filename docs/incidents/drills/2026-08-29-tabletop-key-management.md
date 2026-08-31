# Tabletop Exercise: Key Management & Credential Compromise

> **Closes #227** — Tabletop exercise record for the key-management and
> credential-compromise incident runbooks.

- **Date:** 2026-08-29
- **Facilitator:** Security lead
- **Participants:** Engineering lead, on-call engineer, compliance officer
- **Runbook exercised:** [Key Management Incident Response §13](OPERATOR-RECOVERY-PLAYBOOK.md#13-key-management-incident-response) and [Credential Compromise Response §5d](OPERATOR-RECOVERY-PLAYBOOK.md#5d-credential-compromise-suspected)
- **Duration:** 60 minutes

## Scenario

An operator notices `crypto_decrypt_failed` events in the logs and suspects
that `ENCRYPTION_KEY` may have been rotated without a migration. Separately,
an admin account shows unusual activity in the audit log, suggesting a
compromised session token.

## Exercise flow

1. **Detection (0–5 min):** On-call sees `crypto_decrypt_failed` events and
   unusual admin audit-log entries. Participants identify the affected
   runbooks from the [runbook registry](../RUNBOOK-REGISTRY.md).
2. **Containment (5–15 min):** Participants walk through §13 steps 1–3:
   **do not** rotate `ENCRYPTION_KEY`, page engineering lead and compliance,
   and identify affected wallets. For the credential compromise, participants
   walk through §5d steps 1–3: revoke sessions, disable the account, and
   review audit logs.
3. **Recovery (15–35 min):** Participants walk through §13 steps 4–6: check
   `keyVersion` on wallet rows, run the key rotation migration if a rotation
   was recently deployed, and escalate to CTO if keys are genuinely lost.
   For the credential compromise, participants walk through §5d steps 4–6:
   rotate credentials, notify compliance, and initiate regulatory review.
4. **Communication (35–45 min):** Participants draft the internal P0 alert
   and the regulatory notification template using §10 templates.
5. **Post-incident (45–60 min):** Participants draft the post-incident review
   outline and assign follow-up actions.

## Findings

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| 1 | The playbook §3b covers wallet key decryption failure but does not cover platform-level key management (e.g., `JWT_SECRET`, `WHATSAPP_APP_SECRET`, `ADMIN_PASSWORD` rotation). | High | Add a dedicated §13 Key Management Incident Response section covering all key material. |
| 2 | The credential-compromise scenario in §5b covers admin session compromise but does not cover service-account or API-key compromise. | Medium | Add §5d Credential Compromise Response covering service accounts and API keys. |
| 3 | Participants were unsure whether the key rotation migration script (`rotate-wallet-keys.js`) supports a `--dry-run` flag. | Low | Verify the script's flags and document them in §13. |
| 4 | The runbook registry did not list dedicated key-management or credential-compromise runbooks at the time of the drill. | Low | Add both scenarios to the registry (done in this change). |

## Follow-up actions

| # | Action | Owner | Due date | Status |
|---|--------|-------|----------|--------|
| 1 | Add §13 Key Management Incident Response section to the playbook. | Security lead | 2026-09-05 | Done |
| 2 | Add §5d Credential Compromise Response section to the playbook. | Security lead | 2026-09-05 | Done |
| 3 | Verify `rotate-wallet-keys.js` flags and document them in §13. | Engineering lead | 2026-09-12 | Open |
| 4 | Add key-management and credential-compromise scenarios to the runbook registry. | Security lead | 2026-09-05 | Done |

## Sign-off

- Facilitator: Security lead
- Engineering lead
- Compliance officer

---

*Recorded: 2026-08-29. Next drill due: 2026-11-29.*
