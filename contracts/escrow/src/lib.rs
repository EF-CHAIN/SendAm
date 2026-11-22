#![no_std]

pub mod timelock;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
};

const INSTANCE_LIFETIME_THRESHOLD: u32 = 17_280;
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 17_280;
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    InvalidAmount = 1,
    InvalidDeadline = 2,
    EscrowNotFound = 3,
    AlreadySettled = 4,
    Unauthorized = 5,
    TimelockNotExpired = 6,
    EscrowExpired = 7,
    InsufficientApprovals = 8,
    SameDepositorAndRecipient = 9,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Active = 0,
    Released = 1,
    Refunded = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRecord {
    pub id: u64,
    pub depositor: Address,
    pub recipient: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub created_at: u64,
    pub expires_at: u64,
    pub expires_ledger: u32,
    pub arbiter_approved: bool,
    pub recipient_approved: bool,
    pub require_both_approvals: bool,
    pub status: EscrowStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    NextId,
    Escrow(u64),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowDeposited {
    #[topic]
    pub escrow_id: u64,
    pub depositor: Address,
    pub recipient: Address,
    pub amount: i128,
    pub expires_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowApproved {
    #[topic]
    pub escrow_id: u64,
    pub approver: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowReleased {
    #[topic]
    pub escrow_id: u64,
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRefunded {
    #[topic]
    pub escrow_id: u64,
    pub depositor: Address,
    pub amount: i128,
    pub arbiter_initiated: bool,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Deposits `amount` of `token` from `depositor` into conditional escrow.
    ///
    /// - `expires_at`: UNIX timestamp (seconds) after which the depositor can claw back funds.
    /// - `expires_ledger`: Optional ledger sequence deadline (`0` disables the ledger-height check).
    /// - `require_both_approvals`: When `true`, both `arbiter` and `recipient` must approve release.
    #[allow(clippy::too_many_arguments)]
    pub fn deposit(
        env: Env,
        depositor: Address,
        recipient: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
        expires_at: u64,
        expires_ledger: u32,
        require_both_approvals: bool,
    ) -> Result<u64, EscrowError> {
        depositor.require_auth();

        if amount <= 0 {
            return Err(EscrowError::InvalidAmount);
        }
        if depositor == recipient {
            return Err(EscrowError::SameDepositorAndRecipient);
        }

        timelock::validate_deadline(&env, expires_at, expires_ledger)?;

        let contract_addr = env.current_contract_address();
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&depositor, &contract_addr, &amount);

        let next_id = env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::NextId)
            .unwrap_or(1);

        let record = EscrowRecord {
            id: next_id,
            depositor: depositor.clone(),
            recipient: recipient.clone(),
            arbiter,
            token,
            amount,
            created_at: env.ledger().timestamp(),
            expires_at,
            expires_ledger,
            arbiter_approved: false,
            recipient_approved: false,
            require_both_approvals,
            status: EscrowStatus::Active,
        };

        let key = DataKey::Escrow(next_id);
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.storage()
            .instance()
            .set(&DataKey::NextId, &(next_id + 1));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        EscrowDeposited {
            escrow_id: next_id,
            depositor,
            recipient,
            amount,
            expires_at,
        }
        .publish(&env);

        Ok(next_id)
    }

    /// Records a multi-party release approval from either the `arbiter` or the `recipient`.
    pub fn approve_release(
        env: Env,
        escrow_id: u64,
        approver: Address,
    ) -> Result<EscrowRecord, EscrowError> {
        approver.require_auth();

        let key = DataKey::Escrow(escrow_id);
        let mut record = env
            .storage()
            .persistent()
            .get::<DataKey, EscrowRecord>(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if record.status != EscrowStatus::Active {
            return Err(EscrowError::AlreadySettled);
        }

        timelock::ensure_not_expired(&env, record.expires_at, record.expires_ledger)?;

        timelock::record_approval(
            &approver,
            &record.arbiter,
            &record.recipient,
            &mut record.arbiter_approved,
            &mut record.recipient_approved,
        )?;

        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        EscrowApproved {
            escrow_id,
            approver,
        }
        .publish(&env);

        Ok(record)
    }

    /// Releases escrowed funds to the recipient once authorization requirements are met.
    ///
    /// Only the `arbiter` or `recipient` may invoke `release`. If `require_both_approvals` is
    /// enabled, the other party must have already called `approve_release`.
    pub fn release(env: Env, escrow_id: u64, caller: Address) -> Result<(), EscrowError> {
        caller.require_auth();

        let key = DataKey::Escrow(escrow_id);
        let mut record = env
            .storage()
            .persistent()
            .get::<DataKey, EscrowRecord>(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if record.status != EscrowStatus::Active {
            return Err(EscrowError::AlreadySettled);
        }

        timelock::ensure_not_expired(&env, record.expires_at, record.expires_ledger)?;

        timelock::record_approval(
            &caller,
            &record.arbiter,
            &record.recipient,
            &mut record.arbiter_approved,
            &mut record.recipient_approved,
        )?;

        if !timelock::is_release_ready(
            record.require_both_approvals,
            record.arbiter_approved,
            record.recipient_approved,
        ) {
            return Err(EscrowError::InsufficientApprovals);
        }

        record.status = EscrowStatus::Released;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let token_client = token::Client::new(&env, &record.token);
        token_client.transfer(
            &env.current_contract_address(),
            &record.recipient,
            &record.amount,
        );

        EscrowReleased {
            escrow_id,
            recipient: record.recipient,
            amount: record.amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Refunds escrowed funds back to the depositor after the timelock expiration has passed.
    /// Rejects premature refund attempts before the expiration deadline.
    pub fn refund(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let key = DataKey::Escrow(escrow_id);
        let mut record = env
            .storage()
            .persistent()
            .get::<DataKey, EscrowRecord>(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        record.depositor.require_auth();

        if record.status != EscrowStatus::Active {
            return Err(EscrowError::AlreadySettled);
        }

        timelock::ensure_expired(&env, record.expires_at, record.expires_ledger)?;

        record.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let token_client = token::Client::new(&env, &record.token);
        token_client.transfer(
            &env.current_contract_address(),
            &record.depositor,
            &record.amount,
        );

        EscrowRefunded {
            escrow_id,
            depositor: record.depositor,
            amount: record.amount,
            arbiter_initiated: false,
        }
        .publish(&env);

        Ok(())
    }

    /// Allows the designated arbiter to cancel an active escrow and refund the depositor
    /// prior to expiration (e.g., for compliance cancellation or dispute resolution).
    pub fn arbiter_refund(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let key = DataKey::Escrow(escrow_id);
        let mut record = env
            .storage()
            .persistent()
            .get::<DataKey, EscrowRecord>(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        record.arbiter.require_auth();

        if record.status != EscrowStatus::Active {
            return Err(EscrowError::AlreadySettled);
        }

        record.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let token_client = token::Client::new(&env, &record.token);
        token_client.transfer(
            &env.current_contract_address(),
            &record.depositor,
            &record.amount,
        );

        EscrowRefunded {
            escrow_id,
            depositor: record.depositor,
            amount: record.amount,
            arbiter_initiated: true,
        }
        .publish(&env);

        Ok(())
    }

    /// Returns the stored escrow record for `escrow_id`.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowRecord, EscrowError> {
        env.storage()
            .persistent()
            .get::<DataKey, EscrowRecord>(&DataKey::Escrow(escrow_id))
            .ok_or(EscrowError::EscrowNotFound)
    }

    /// Returns `true` if the escrow has reached its expiration timestamp or ledger height.
    pub fn is_expired(env: Env, escrow_id: u64) -> Result<bool, EscrowError> {
        let record = Self::get_escrow(env.clone(), escrow_id)?;
        Ok(timelock::is_expired(
            &env,
            record.expires_at,
            record.expires_ledger,
        ))
    }

    /// Returns the number of seconds remaining until the escrow's expiration timestamp.
    pub fn time_remaining(env: Env, escrow_id: u64) -> Result<u64, EscrowError> {
        let record = Self::get_escrow(env.clone(), escrow_id)?;
        Ok(timelock::time_remaining(&env, record.expires_at))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
    use soroban_sdk::{token::StellarAssetClient, IntoVal};

    fn setup_env() -> (Env, Address, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
            li.sequence_number = 100;
        });

        let contract_id = env.register(EscrowContract, ());
        let token_admin = Address::generate(&env);
        let stellar_asset = env.register_stellar_asset_contract_v2(token_admin);
        let token_id = stellar_asset.address();

        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let outsider = Address::generate(&env);

        env.mock_all_auths();
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &10_000);

        (
            env,
            contract_id,
            token_id,
            depositor,
            recipient,
            arbiter,
            outsider,
        )
    }

    #[test]
    fn test_deposit_and_single_party_release_by_arbiter() {
        let (env, contract_id, token_id, depositor, recipient, arbiter, _) = setup_env();
        let client = EscrowContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &token_id);

        let escrow_id = client.deposit(
            &depositor, &recipient, &arbiter, &token_id, &2_500, &2_000, &0, &false,
        );
        assert_eq!(escrow_id, 1);
        assert_eq!(token.balance(&depositor), 7_500);
        assert_eq!(token.balance(&contract_id), 2_500);
        assert_eq!(client.time_remaining(&escrow_id), 1_000);
        assert!(!client.is_expired(&escrow_id));

        client.release(&escrow_id, &arbiter);

        assert_eq!(token.balance(&contract_id), 0);
        assert_eq!(token.balance(&recipient), 2_500);
        let record = client.get_escrow(&escrow_id);
        assert_eq!(record.status, EscrowStatus::Released);
        assert!(record.arbiter_approved);
    }

    #[test]
    fn test_depositor_and_outsider_cannot_release_funds() {
        let (env, contract_id, token_id, depositor, recipient, arbiter, outsider) = setup_env();
        let client = EscrowContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &token_id);

        let escrow_id = client.deposit(
            &depositor, &recipient, &arbiter, &token_id, &1_000, &2_000, &0, &false,
        );

        let depositor_attempt = client.try_release(&escrow_id, &depositor);
        assert_eq!(depositor_attempt, Err(Ok(EscrowError::Unauthorized)));

        let outsider_attempt = client.try_release(&escrow_id, &outsider);
        assert_eq!(outsider_attempt, Err(Ok(EscrowError::Unauthorized)));

        assert_eq!(token.balance(&contract_id), 1_000);
        assert_eq!(token.balance(&recipient), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Auth, InvalidAction)")]
    fn test_release_without_arbiter_or_recipient_signature_panics() {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
            li.sequence_number = 100;
        });

        let contract_id = env.register(EscrowContract, ());
        let token_admin = Address::generate(&env);
        let stellar_asset = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_id = stellar_asset.address();

        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);

        env.mock_all_auths();
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &5_000);

        let client = EscrowContractClient::new(&env, &contract_id);
        let escrow_id = client.deposit(
            &depositor, &recipient, &arbiter, &token_id, &1_000, &2_000, &0, &false,
        );

        // Clear mocked auths and provide ONLY depositor's signature for release as arbiter.
        env.set_auths(&[]);
        client
            .mock_auths(&[MockAuth {
                address: &depositor,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "release",
                    args: (escrow_id, arbiter.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .release(&escrow_id, &arbiter);
    }

    #[test]
    fn test_multiparty_release_requires_both_arbiter_and_recipient() {
        let (env, contract_id, token_id, depositor, recipient, arbiter, _) = setup_env();
        let client = EscrowContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &token_id);

        let escrow_id = client.deposit(
            &depositor, &recipient, &arbiter, &token_id, &3_000, &2_000, &0, &true,
        );

        // Attempting release with only arbiter approval fails.
        let single_release = client.try_release(&escrow_id, &arbiter);
        assert_eq!(single_release, Err(Ok(EscrowError::InsufficientApprovals)));
        assert_eq!(token.balance(&recipient), 0);

        // Arbiter records approval first.
        let updated = client.approve_release(&escrow_id, &arbiter);
        assert!(updated.arbiter_approved);
        assert!(!updated.recipient_approved);

        // Arbiter alone still cannot release.
        let still_insufficient = client.try_release(&escrow_id, &arbiter);
        assert_eq!(
            still_insufficient,
            Err(Ok(EscrowError::InsufficientApprovals))
        );

        // Recipient invokes release, completing 2-of-2 multi-party release.
        client.release(&escrow_id, &recipient);
        assert_eq!(token.balance(&recipient), 3_000);
        assert_eq!(token.balance(&contract_id), 0);

        let final_record = client.get_escrow(&escrow_id);
        assert_eq!(final_record.status, EscrowStatus::Released);
        assert!(final_record.arbiter_approved);
        assert!(final_record.recipient_approved);
    }

    #[test]
    fn test_timelock_rejects_premature_refund_and_allows_clawback_after_expiry() {
        let (env, contract_id, token_id, depositor, recipient, arbiter, _) = setup_env();
        let client = EscrowContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &token_id);

        let escrow_id = client.deposit(
            &depositor, &recipient, &arbiter, &token_id, &4_000, &2_000, &0, &false,
        );

        // Premature refund at t=1_000 must fail.
        assert_eq!(
            client.try_refund(&escrow_id),
            Err(Ok(EscrowError::TimelockNotExpired))
        );

        // One second before expiry (t=1_999) still fails.
        env.ledger().with_mut(|li| li.timestamp = 1_999);
        assert!(!client.is_expired(&escrow_id));
        assert_eq!(
            client.try_refund(&escrow_id),
            Err(Ok(EscrowError::TimelockNotExpired))
        );

        // At expiration timestamp (t=2_000), release is rejected and refund succeeds.
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        assert!(client.is_expired(&escrow_id));
        assert_eq!(client.time_remaining(&escrow_id), 0);
        assert_eq!(
            client.try_release(&escrow_id, &arbiter),
            Err(Ok(EscrowError::EscrowExpired))
        );

        client.refund(&escrow_id);
        assert_eq!(token.balance(&depositor), 10_000);
        assert_eq!(token.balance(&contract_id), 0);
        assert_eq!(client.get_escrow(&escrow_id).status, EscrowStatus::Refunded);

        // Second refund must fail as already settled.
        assert_eq!(
            client.try_refund(&escrow_id),
            Err(Ok(EscrowError::AlreadySettled))
        );
    }

    #[test]
    fn test_timelock_expiration_by_ledger_height() {
        let (env, contract_id, token_id, depositor, recipient, arbiter, _) = setup_env();
        let client = EscrowContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &token_id);

        let escrow_id = client.deposit(
            &depositor, &recipient, &arbiter, &token_id, &1_500, &50_000, &150, &false,
        );

        // At ledger 149, still active.
        env.ledger().with_mut(|li| li.sequence_number = 149);
        assert!(!client.is_expired(&escrow_id));
        assert_eq!(
            client.try_refund(&escrow_id),
            Err(Ok(EscrowError::TimelockNotExpired))
        );

        // At ledger 150, expired even though timestamp is still 1_000.
        env.ledger().with_mut(|li| li.sequence_number = 150);
        assert!(client.is_expired(&escrow_id));
        client.refund(&escrow_id);
        assert_eq!(token.balance(&depositor), 10_000);
    }

    #[test]
    fn test_arbiter_early_refund() {
        let (env, contract_id, token_id, depositor, recipient, arbiter, _) = setup_env();
        let client = EscrowContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &token_id);

        let escrow_id = client.deposit(
            &depositor, &recipient, &arbiter, &token_id, &2_000, &5_000, &0, &false,
        );

        client.arbiter_refund(&escrow_id);
        assert_eq!(token.balance(&depositor), 10_000);
        assert_eq!(client.get_escrow(&escrow_id).status, EscrowStatus::Refunded);
    }

    #[test]
    fn test_validation_errors() {
        let (env, contract_id, token_id, depositor, recipient, arbiter, _) = setup_env();
        let client = EscrowContractClient::new(&env, &contract_id);

        // Zero and negative amounts rejected.
        assert_eq!(
            client.try_deposit(&depositor, &recipient, &arbiter, &token_id, &0, &2_000, &0, &false),
            Err(Ok(EscrowError::InvalidAmount))
        );
        assert_eq!(
            client
                .try_deposit(&depositor, &recipient, &arbiter, &token_id, &-10, &2_000, &0, &false),
            Err(Ok(EscrowError::InvalidAmount))
        );

        // Self-escrow rejected.
        assert_eq!(
            client
                .try_deposit(&depositor, &depositor, &arbiter, &token_id, &100, &2_000, &0, &false),
            Err(Ok(EscrowError::SameDepositorAndRecipient))
        );

        // Past or present deadline rejected.
        assert_eq!(
            client
                .try_deposit(&depositor, &recipient, &arbiter, &token_id, &100, &1_000, &0, &false),
            Err(Ok(EscrowError::InvalidDeadline))
        );

        // Past or present ledger deadline rejected.
        assert_eq!(
            client.try_deposit(
                &depositor, &recipient, &arbiter, &token_id, &100, &2_000, &100, &false
            ),
            Err(Ok(EscrowError::InvalidDeadline))
        );

        // Non-existent escrow lookup rejected.
        assert_eq!(
            client.try_get_escrow(&999),
            Err(Ok(EscrowError::EscrowNotFound))
        );
    }
}
