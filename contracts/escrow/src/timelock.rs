use soroban_sdk::{Address, Env};

use crate::EscrowError;

/// Validates that the configured expiration timestamp and optional ledger height
/// are strictly in the future relative to the current ledger state.
pub fn validate_deadline(
    env: &Env,
    expires_at: u64,
    expires_ledger: u32,
) -> Result<(), EscrowError> {
    if expires_at <= env.ledger().timestamp() {
        return Err(EscrowError::InvalidDeadline);
    }
    if expires_ledger > 0 && expires_ledger <= env.ledger().sequence() {
        return Err(EscrowError::InvalidDeadline);
    }
    Ok(())
}

/// Returns `true` when either the expiration timestamp or the optional expiration
/// ledger height has been reached or exceeded.
pub fn is_expired(env: &Env, expires_at: u64, expires_ledger: u32) -> bool {
    let timestamp_expired = env.ledger().timestamp() >= expires_at;
    let ledger_expired = expires_ledger > 0 && env.ledger().sequence() >= expires_ledger;
    timestamp_expired || ledger_expired
}

/// Ensures the escrow timelock has expired so sender clawback is permitted.
pub fn ensure_expired(env: &Env, expires_at: u64, expires_ledger: u32) -> Result<(), EscrowError> {
    if !is_expired(env, expires_at, expires_ledger) {
        return Err(EscrowError::TimelockNotExpired);
    }
    Ok(())
}

/// Ensures the escrow timelock has not yet expired before permitting approval or release.
pub fn ensure_not_expired(
    env: &Env,
    expires_at: u64,
    expires_ledger: u32,
) -> Result<(), EscrowError> {
    if is_expired(env, expires_at, expires_ledger) {
        return Err(EscrowError::EscrowExpired);
    }
    Ok(())
}

/// Returns the number of seconds remaining until `expires_at`, saturating at zero.
pub fn time_remaining(env: &Env, expires_at: u64) -> u64 {
    expires_at.saturating_sub(env.ledger().timestamp())
}

/// Records an approval from either the arbiter or the recipient.
/// Rejects any other caller (including the depositor) as unauthorized.
pub fn record_approval(
    approver: &Address,
    arbiter: &Address,
    recipient: &Address,
    arbiter_approved: &mut bool,
    recipient_approved: &mut bool,
) -> Result<(), EscrowError> {
    let mut matched = false;
    if approver == arbiter {
        *arbiter_approved = true;
        matched = true;
    }
    if approver == recipient {
        *recipient_approved = true;
        matched = true;
    }
    if !matched {
        return Err(EscrowError::Unauthorized);
    }
    Ok(())
}

/// Evaluates whether the required release approvals have been satisfied.
pub fn is_release_ready(
    require_both: bool,
    arbiter_approved: bool,
    recipient_approved: bool,
) -> bool {
    if require_both {
        arbiter_approved && recipient_approved
    } else {
        arbiter_approved || recipient_approved
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    #[test]
    fn test_deadline_validation_and_expiration_boundaries() {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.timestamp = 500;
            li.sequence_number = 50;
        });

        assert_eq!(
            validate_deadline(&env, 500, 0),
            Err(EscrowError::InvalidDeadline)
        );
        assert_eq!(
            validate_deadline(&env, 600, 50),
            Err(EscrowError::InvalidDeadline)
        );
        assert!(validate_deadline(&env, 600, 0).is_ok());
        assert!(validate_deadline(&env, 600, 51).is_ok());

        assert!(!is_expired(&env, 600, 51));
        assert_eq!(time_remaining(&env, 600), 100);
        assert_eq!(
            ensure_expired(&env, 600, 51),
            Err(EscrowError::TimelockNotExpired)
        );
        assert!(ensure_not_expired(&env, 600, 51).is_ok());

        env.ledger().with_mut(|li| li.timestamp = 600);
        assert!(is_expired(&env, 600, 51));
        assert_eq!(time_remaining(&env, 600), 0);
        assert!(ensure_expired(&env, 600, 51).is_ok());
        assert_eq!(
            ensure_not_expired(&env, 600, 51),
            Err(EscrowError::EscrowExpired)
        );
    }

    #[test]
    fn test_record_approval_and_release_readiness() {
        let env = Env::default();
        let arbiter = Address::generate(&env);
        let recipient = Address::generate(&env);
        let depositor = Address::generate(&env);

        let mut arbiter_ok = false;
        let mut recipient_ok = false;

        assert_eq!(
            record_approval(
                &depositor,
                &arbiter,
                &recipient,
                &mut arbiter_ok,
                &mut recipient_ok
            ),
            Err(EscrowError::Unauthorized)
        );
        assert!(!is_release_ready(false, arbiter_ok, recipient_ok));
        assert!(!is_release_ready(true, arbiter_ok, recipient_ok));

        assert!(record_approval(
            &arbiter,
            &arbiter,
            &recipient,
            &mut arbiter_ok,
            &mut recipient_ok
        )
        .is_ok());
        assert!(is_release_ready(false, arbiter_ok, recipient_ok));
        assert!(!is_release_ready(true, arbiter_ok, recipient_ok));

        assert!(record_approval(
            &recipient,
            &arbiter,
            &recipient,
            &mut arbiter_ok,
            &mut recipient_ok
        )
        .is_ok());
        assert!(is_release_ready(true, arbiter_ok, recipient_ok));
    }
}
