#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

struct TestHarness {
    env: Env,
    contract_id: Address,
    token_id: Address,
    depositor: Address,
    recipient: Address,
    arbiter: Address,
    outsider: Address,
}

impl TestHarness {
    fn new(mock_auths: bool) -> Self {
        let env = Env::default();
        if mock_auths {
            env.mock_all_auths();
        }
        env.ledger().with_mut(|li| {
            li.timestamp = 1_700_000_000;
            li.sequence_number = 100;
        });

        let contract_id = env.register(EscrowContract, ());
        let token_admin_addr = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(token_admin_addr);
        let token_id = sac.address();

        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let outsider = Address::generate(&env);

        if mock_auths {
            let sac_admin = StellarAssetClient::new(&env, &token_id);
            sac_admin.mint(&depositor, &10_000_000);
        }

        Self {
            env,
            contract_id,
            token_id,
            depositor,
            recipient,
            arbiter,
            outsider,
        }
    }

    fn client(&self) -> EscrowContractClient<'_> {
        EscrowContractClient::new(&self.env, &self.contract_id)
    }

    fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token_id)
    }

    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    fn advance_time(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| {
            li.timestamp += seconds;
            li.sequence_number += 1;
        });
    }

    fn create_default_escrow(&self, escrow_id: u64, amount: i128, ttl_secs: u64) -> Escrow {
        self.client().deposit(
            &escrow_id,
            &self.depositor,
            &self.recipient,
            &self.arbiter,
            &self.token_id,
            &amount,
            &(self.now() + ttl_secs),
        )
    }
}

/// Malicious token contract that attempts a reentrant call back into EscrowContract
/// during `transfer`, simulating a hostile callback / reentrancy attack.
#[contract]
pub struct ReentrantTokenContract;

#[contracttype]
#[derive(Clone)]
pub enum AttackKey {
    TargetEscrow,
    EscrowId,
    Attacker,
    Mode, // 1 = release, 2 = refund
    ReentryBlocked,
    TransferCount,
}

#[contractimpl]
impl ReentrantTokenContract {
    pub fn configure(
        env: Env,
        target_escrow: Address,
        escrow_id: u64,
        attacker: Address,
        mode: u32,
    ) {
        env.storage()
            .instance()
            .set(&AttackKey::TargetEscrow, &target_escrow);
        env.storage()
            .instance()
            .set(&AttackKey::EscrowId, &escrow_id);
        env.storage()
            .instance()
            .set(&AttackKey::Attacker, &attacker);
        env.storage().instance().set(&AttackKey::Mode, &mode);
        env.storage()
            .instance()
            .set(&AttackKey::ReentryBlocked, &false);
        env.storage()
            .instance()
            .set(&AttackKey::TransferCount, &0u32);
    }

    pub fn transfer(env: Env, from: Address, _to: Address, _amount: i128) {
        let count: u32 = env
            .storage()
            .instance()
            .get(&AttackKey::TransferCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&AttackKey::TransferCount, &(count + 1));

        // Only trigger attack when funds are leaving the escrow contract (on release/refund).
        let target: Address = env
            .storage()
            .instance()
            .get(&AttackKey::TargetEscrow)
            .unwrap();
        if from != target {
            return;
        }

        let escrow_id: u64 = env.storage().instance().get(&AttackKey::EscrowId).unwrap();
        let attacker: Address = env.storage().instance().get(&AttackKey::Attacker).unwrap();
        let mode: u32 = env.storage().instance().get(&AttackKey::Mode).unwrap();

        let escrow_client = EscrowContractClient::new(&env, &target);
        let reentrant_res = if mode == 1 {
            escrow_client.try_release(&escrow_id, &attacker)
        } else {
            escrow_client.try_refund(&escrow_id, &attacker)
        };

        // Reentrancy is rejected either by the Soroban host (Err(Err(_))) or
        // by EscrowContract's own reentrancy guard (Err(Ok(ReentrancyDetected))).
        if reentrant_res.is_err() {
            env.storage()
                .instance()
                .set(&AttackKey::ReentryBlocked, &true);
        }
    }

    pub fn reentry_blocked(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&AttackKey::ReentryBlocked)
            .unwrap_or(false)
    }

    pub fn transfer_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&AttackKey::TransferCount)
            .unwrap_or(0)
    }
}

#[test]
fn test_01_deposit_locks_funds_and_records_escrow() {
    let h = TestHarness::new(true);
    let expires_at = h.now() + 3600;

    let escrow = h.client().deposit(
        &1,
        &h.depositor,
        &h.recipient,
        &h.arbiter,
        &h.token_id,
        &1_000_000,
        &expires_at,
    );

    assert_eq!(escrow.id, 1);
    assert_eq!(escrow.depositor, h.depositor);
    assert_eq!(escrow.recipient, h.recipient);
    assert_eq!(escrow.arbiter, h.arbiter);
    assert_eq!(escrow.amount, 1_000_000);
    assert_eq!(escrow.status, EscrowStatus::Active);
    assert_eq!(escrow.expires_at, expires_at);

    assert_eq!(h.token().balance(&h.depositor), 9_000_000);
    assert_eq!(h.token().balance(&h.contract_id), 1_000_000);
    assert_eq!(h.token().balance(&h.recipient), 0);
    assert!(!h.client().is_locked());
}

#[test]
fn test_02_release_by_depositor_transfers_to_recipient() {
    let h = TestHarness::new(true);
    h.create_default_escrow(2, 2_500_000, 3600);

    let released = h.client().release(&2, &h.depositor);
    assert_eq!(released.status, EscrowStatus::Released);
    assert_eq!(h.token().balance(&h.recipient), 2_500_000);
    assert_eq!(h.token().balance(&h.contract_id), 0);
    assert!(!h.client().is_locked());
}

#[test]
fn test_03_release_by_arbiter_transfers_to_recipient() {
    let h = TestHarness::new(true);
    h.create_default_escrow(3, 500_000, 3600);

    let released = h.client().release(&3, &h.arbiter);
    assert_eq!(released.status, EscrowStatus::Released);
    assert_eq!(h.token().balance(&h.recipient), 500_000);
    assert_eq!(h.token().balance(&h.contract_id), 0);
}

#[test]
fn test_04_release_rejects_unauthorized_outsider() {
    let h = TestHarness::new(true);
    h.create_default_escrow(4, 1_000_000, 3600);

    let res = h.client().try_release(&4, &h.outsider);
    assert_eq!(res, Err(Ok(EscrowError::Unauthorized)));
    assert_eq!(h.token().balance(&h.contract_id), 1_000_000);
    assert_eq!(h.client().get_escrow(&4).status, EscrowStatus::Active);
}

#[test]
fn test_05_release_rejects_recipient_self_claim() {
    let h = TestHarness::new(true);
    h.create_default_escrow(5, 1_000_000, 3600);

    let res = h.client().try_release(&5, &h.recipient);
    assert_eq!(res, Err(Ok(EscrowError::Unauthorized)));
    assert_eq!(h.token().balance(&h.recipient), 0);
}

#[test]
#[should_panic]
fn test_06_deposit_panics_without_depositor_auth() {
    let h = TestHarness::new(false);
    // No mock_all_auths -> require_auth() must fail.
    h.client().deposit(
        &6,
        &h.depositor,
        &h.recipient,
        &h.arbiter,
        &h.token_id,
        &100,
        &(h.now() + 3600),
    );
}

#[test]
fn test_07_release_rejected_after_expiration_time_jump() {
    let h = TestHarness::new(true);
    h.create_default_escrow(7, 1_000_000, 600);

    h.advance_time(601);

    let res = h.client().try_release(&7, &h.depositor);
    assert_eq!(res, Err(Ok(EscrowError::EscrowExpired)));
    assert_eq!(h.token().balance(&h.recipient), 0);
    assert_eq!(h.token().balance(&h.contract_id), 1_000_000);
}

#[test]
fn test_08_exact_expiry_boundary_blocks_release_and_allows_refund() {
    let h = TestHarness::new(true);
    h.create_default_escrow(8, 750_000, 1200);

    // Jump to exact expiration timestamp: now == expires_at.
    h.advance_time(1200);

    assert_eq!(
        h.client().try_release(&8, &h.arbiter),
        Err(Ok(EscrowError::EscrowExpired))
    );

    let refunded = h.client().refund(&8, &h.depositor);
    assert_eq!(refunded.status, EscrowStatus::Refunded);
    assert_eq!(h.token().balance(&h.depositor), 10_000_000);
    assert_eq!(h.token().balance(&h.contract_id), 0);
}

#[test]
fn test_09_premature_refund_by_depositor_rejected() {
    let h = TestHarness::new(true);
    h.create_default_escrow(9, 1_000_000, 3600);

    // Advance 3599s — still 1 second before expiry.
    h.advance_time(3599);

    let res = h.client().try_refund(&9, &h.depositor);
    assert_eq!(res, Err(Ok(EscrowError::EscrowNotExpired)));
    assert_eq!(h.token().balance(&h.contract_id), 1_000_000);
}

#[test]
fn test_10_refund_by_depositor_succeeds_after_expiry() {
    let h = TestHarness::new(true);
    h.create_default_escrow(10, 3_000_000, 1800);

    h.advance_time(2000);

    let refunded = h.client().refund(&10, &h.depositor);
    assert_eq!(refunded.status, EscrowStatus::Refunded);
    assert_eq!(h.token().balance(&h.depositor), 10_000_000);
    assert_eq!(h.token().balance(&h.contract_id), 0);
}

#[test]
fn test_11_early_refund_by_arbiter_succeeds_before_expiry() {
    let h = TestHarness::new(true);
    h.create_default_escrow(11, 1_500_000, 3600);

    let refunded = h.client().refund(&11, &h.arbiter);
    assert_eq!(refunded.status, EscrowStatus::Refunded);
    assert_eq!(h.token().balance(&h.depositor), 10_000_000);
}

#[test]
fn test_12_early_refund_by_recipient_voluntary_cancel_succeeds() {
    let h = TestHarness::new(true);
    h.create_default_escrow(12, 800_000, 3600);

    let refunded = h.client().refund(&12, &h.recipient);
    assert_eq!(refunded.status, EscrowStatus::Refunded);
    assert_eq!(h.token().balance(&h.depositor), 10_000_000);
}

#[test]
fn test_13_refund_rejects_unauthorized_outsider() {
    let h = TestHarness::new(true);
    h.create_default_escrow(13, 1_000_000, 600);
    h.advance_time(1000);

    let res = h.client().try_refund(&13, &h.outsider);
    assert_eq!(res, Err(Ok(EscrowError::Unauthorized)));
    assert_eq!(h.token().balance(&h.contract_id), 1_000_000);
}

#[test]
fn test_14_double_release_rejected() {
    let h = TestHarness::new(true);
    h.create_default_escrow(14, 1_000_000, 3600);

    h.client().release(&14, &h.depositor);
    let second = h.client().try_release(&14, &h.arbiter);
    assert_eq!(second, Err(Ok(EscrowError::InvalidStatus)));
    assert_eq!(h.token().balance(&h.recipient), 1_000_000);
}

#[test]
fn test_15_double_refund_rejected() {
    let h = TestHarness::new(true);
    h.create_default_escrow(15, 1_000_000, 600);
    h.advance_time(601);

    h.client().refund(&15, &h.depositor);
    let second = h.client().try_refund(&15, &h.depositor);
    assert_eq!(second, Err(Ok(EscrowError::InvalidStatus)));
    assert_eq!(h.token().balance(&h.depositor), 10_000_000);
}

#[test]
fn test_16_refund_after_release_rejected() {
    let h = TestHarness::new(true);
    h.create_default_escrow(16, 1_000_000, 600);

    h.client().release(&16, &h.depositor);
    h.advance_time(1000);

    let res = h.client().try_refund(&16, &h.depositor);
    assert_eq!(res, Err(Ok(EscrowError::InvalidStatus)));
}

#[test]
fn test_17_duplicate_escrow_id_rejected() {
    let h = TestHarness::new(true);
    h.create_default_escrow(17, 500_000, 3600);

    let dup = h.client().try_deposit(
        &17,
        &h.depositor,
        &h.recipient,
        &h.arbiter,
        &h.token_id,
        &500_000,
        &(h.now() + 3600),
    );
    assert_eq!(dup, Err(Ok(EscrowError::EscrowAlreadyExists)));
    assert_eq!(h.token().balance(&h.contract_id), 500_000);
}

#[test]
fn test_18_zero_and_negative_amounts_rejected() {
    let h = TestHarness::new(true);

    let zero = h.client().try_deposit(
        &18,
        &h.depositor,
        &h.recipient,
        &h.arbiter,
        &h.token_id,
        &0,
        &(h.now() + 3600),
    );
    assert_eq!(zero, Err(Ok(EscrowError::InvalidAmount)));

    let neg = h.client().try_deposit(
        &180,
        &h.depositor,
        &h.recipient,
        &h.arbiter,
        &h.token_id,
        &-500,
        &(h.now() + 3600),
    );
    assert_eq!(neg, Err(Ok(EscrowError::InvalidAmount)));
}

#[test]
fn test_19_past_or_current_expiry_rejected() {
    let h = TestHarness::new(true);
    let now = h.now();

    let equal = h.client().try_deposit(
        &19,
        &h.depositor,
        &h.recipient,
        &h.arbiter,
        &h.token_id,
        &100,
        &now,
    );
    assert_eq!(equal, Err(Ok(EscrowError::InvalidExpiry)));

    let past = h.client().try_deposit(
        &190,
        &h.depositor,
        &h.recipient,
        &h.arbiter,
        &h.token_id,
        &100,
        &(now - 10),
    );
    assert_eq!(past, Err(Ok(EscrowError::InvalidExpiry)));
}

#[test]
fn test_20_same_depositor_and_recipient_rejected() {
    let h = TestHarness::new(true);

    let res = h.client().try_deposit(
        &20,
        &h.depositor,
        &h.depositor,
        &h.arbiter,
        &h.token_id,
        &1_000,
        &(h.now() + 3600),
    );
    assert_eq!(res, Err(Ok(EscrowError::InvalidParties)));
}

#[test]
fn test_21_nonexistent_escrow_operations_return_not_found() {
    let h = TestHarness::new(true);

    assert_eq!(
        h.client().try_get_escrow(&999),
        Err(Ok(EscrowError::EscrowNotFound))
    );
    assert_eq!(
        h.client().try_release(&999, &h.depositor),
        Err(Ok(EscrowError::EscrowNotFound))
    );
    assert_eq!(
        h.client().try_refund(&999, &h.depositor),
        Err(Ok(EscrowError::EscrowNotFound))
    );
}

#[test]
fn test_22_dispute_by_depositor_resolved_to_recipient_by_arbiter() {
    let h = TestHarness::new(true);
    h.create_default_escrow(22, 1_200_000, 3600);

    let disputed = h.client().dispute(&22, &h.depositor);
    assert_eq!(disputed.status, EscrowStatus::Disputed);

    // Normal release and refund are blocked while disputed.
    assert_eq!(
        h.client().try_release(&22, &h.depositor),
        Err(Ok(EscrowError::InvalidStatus))
    );
    assert_eq!(
        h.client().try_refund(&22, &h.arbiter),
        Err(Ok(EscrowError::InvalidStatus))
    );

    // Arbiter resolves in favor of recipient even after original expiry.
    h.advance_time(5000);
    let resolved = h.client().resolve_dispute(&22, &true);
    assert_eq!(resolved.status, EscrowStatus::Released);
    assert_eq!(h.token().balance(&h.recipient), 1_200_000);
}

#[test]
fn test_23_dispute_by_recipient_resolved_to_depositor_by_arbiter() {
    let h = TestHarness::new(true);
    h.create_default_escrow(23, 900_000, 3600);

    let disputed = h.client().dispute(&23, &h.recipient);
    assert_eq!(disputed.status, EscrowStatus::Disputed);

    let resolved = h.client().resolve_dispute(&23, &false);
    assert_eq!(resolved.status, EscrowStatus::Refunded);
    assert_eq!(h.token().balance(&h.depositor), 10_000_000);
}

#[test]
fn test_24_dispute_rejects_outsider_and_expired_escrow() {
    let h = TestHarness::new(true);
    h.create_default_escrow(24, 500_000, 600);

    assert_eq!(
        h.client().try_dispute(&24, &h.outsider),
        Err(Ok(EscrowError::Unauthorized))
    );
    assert_eq!(
        h.client().try_resolve_dispute(&24, &true),
        Err(Ok(EscrowError::InvalidStatus))
    );

    h.advance_time(600);
    assert_eq!(
        h.client().try_dispute(&24, &h.depositor),
        Err(Ok(EscrowError::EscrowExpired))
    );
}

#[test]
fn test_25_extend_expiry_allows_release_past_original_deadline() {
    let h = TestHarness::new(true);
    let orig_expiry = h.now() + 600;
    h.create_default_escrow(25, 1_000_000, 600);

    // Reject shorter or equal expiry.
    assert_eq!(
        h.client().try_extend_expiry(&25, &orig_expiry),
        Err(Ok(EscrowError::InvalidExpiry))
    );

    // Extend by another 1000 seconds.
    let extended = h.client().extend_expiry(&25, &(orig_expiry + 1000));
    assert_eq!(extended.expires_at, orig_expiry + 1000);

    // Jump past original deadline, before extended deadline.
    h.advance_time(800);
    let released = h.client().release(&25, &h.depositor);
    assert_eq!(released.status, EscrowStatus::Released);
    assert_eq!(h.token().balance(&h.recipient), 1_000_000);
}

#[test]
fn test_26_multiple_escrows_remain_isolated() {
    let h = TestHarness::new(true);
    h.create_default_escrow(101, 1_000_000, 600);
    h.create_default_escrow(102, 2_000_000, 1800);
    h.create_default_escrow(103, 3_000_000, 3600);

    assert_eq!(h.token().balance(&h.contract_id), 6_000_000);

    // Release 102, let 101 expire and refund, keep 103 active.
    h.client().release(&102, &h.arbiter);
    h.advance_time(700);
    h.client().refund(&101, &h.depositor);

    assert_eq!(h.client().get_escrow(&101).status, EscrowStatus::Refunded);
    assert_eq!(h.client().get_escrow(&102).status, EscrowStatus::Released);
    assert_eq!(h.client().get_escrow(&103).status, EscrowStatus::Active);
    assert_eq!(h.token().balance(&h.recipient), 2_000_000);
    assert_eq!(h.token().balance(&h.contract_id), 3_000_000);
    assert_eq!(h.token().balance(&h.depositor), 5_000_000);
}

#[test]
fn test_27_reentrancy_attack_during_release_is_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_700_000_000;
    });

    let escrow_id_addr = env.register(EscrowContract, ());
    let malicious_token_addr = env.register(ReentrantTokenContract, ());

    let depositor = Address::generate(&env);
    let recipient = Address::generate(&env);
    let arbiter = Address::generate(&env);

    let escrow_client = EscrowContractClient::new(&env, &escrow_id_addr);
    let token_client = ReentrantTokenContractClient::new(&env, &malicious_token_addr);

    // Mode 1 = malicious token attempts reentrant `release()` during payout transfer.
    token_client.configure(&escrow_id_addr, &77, &depositor, &1);

    escrow_client.deposit(
        &77,
        &depositor,
        &recipient,
        &arbiter,
        &malicious_token_addr,
        &5_000_000,
        &(env.ledger().timestamp() + 3600),
    );

    let released = escrow_client.release(&77, &depositor);
    assert_eq!(released.status, EscrowStatus::Released);
    assert!(
        token_client.reentry_blocked(),
        "reentrant release must be rejected with ReentrancyDetected"
    );
    // Exactly 2 transfers: 1 for deposit, 1 for release (no second drain transfer).
    assert_eq!(token_client.transfer_count(), 2);
    assert!(!escrow_client.is_locked());
}

#[test]
fn test_28_reentrancy_attack_during_refund_is_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_700_000_000;
    });

    let escrow_id_addr = env.register(EscrowContract, ());
    let malicious_token_addr = env.register(ReentrantTokenContract, ());

    let depositor = Address::generate(&env);
    let recipient = Address::generate(&env);
    let arbiter = Address::generate(&env);

    let escrow_client = EscrowContractClient::new(&env, &escrow_id_addr);
    let token_client = ReentrantTokenContractClient::new(&env, &malicious_token_addr);

    // Mode 2 = malicious token attempts reentrant `refund()` during refund transfer.
    token_client.configure(&escrow_id_addr, &88, &depositor, &2);

    escrow_client.deposit(
        &88,
        &depositor,
        &recipient,
        &arbiter,
        &malicious_token_addr,
        &5_000_000,
        &(env.ledger().timestamp() + 600),
    );

    env.ledger().with_mut(|li| {
        li.timestamp += 700;
    });

    let refunded = escrow_client.refund(&88, &depositor);
    assert_eq!(refunded.status, EscrowStatus::Refunded);
    assert!(
        token_client.reentry_blocked(),
        "reentrant refund must be rejected with ReentrancyDetected"
    );
    assert_eq!(token_client.transfer_count(), 2);
    assert!(!escrow_client.is_locked());
}

#[test]
fn test_29_cpu_and_memory_budget_within_soroban_limits() {
    let h = TestHarness::new(true);

    h.env.cost_estimate().budget().reset_default();
    h.create_default_escrow(29, 1_000_000, 3600);
    let deposit_cpu = h.env.cost_estimate().budget().cpu_instruction_cost();
    let deposit_mem = h.env.cost_estimate().budget().memory_bytes_cost();

    h.env.cost_estimate().budget().reset_default();
    h.client().release(&29, &h.depositor);
    let release_cpu = h.env.cost_estimate().budget().cpu_instruction_cost();
    let release_mem = h.env.cost_estimate().budget().memory_bytes_cost();

    // Soroban mainnet per-tx limits are 100M CPU instructions and 40MB memory.
    // Ensure our escrow operations stay well below 10% of protocol limits.
    assert!(deposit_cpu > 0 && deposit_cpu < 10_000_000);
    assert!(deposit_mem > 0 && deposit_mem < 4_000_000);
    assert!(release_cpu > 0 && release_cpu < 10_000_000);
    assert!(release_mem > 0 && release_mem < 4_000_000);
}

#[test]
fn test_30_events_emitted_for_escrow_lifecycle() {
    let h = TestHarness::new(true);
    h.create_default_escrow(30, 1_000_000, 3600);
    h.client().release(&30, &h.depositor);

    let last_event = h.env.events().all().filter_by_contract(&h.contract_id);
    assert!(
        !last_event.events().is_empty(),
        "expected contract events to be emitted"
    );
}

#[test]
fn test_31_contract_level_reentrancy_guard_rejects_when_lock_active() {
    let h = TestHarness::new(true);
    h.create_default_escrow(31, 1_000_000, 3600);

    // Simulate an active reentrancy lock directly in contract storage.
    h.env.as_contract(&h.contract_id, || {
        h.env
            .storage()
            .instance()
            .set(&DataKey::ReentrancyLock, &true);
    });
    assert!(h.client().is_locked());

    assert_eq!(
        h.client().try_release(&31, &h.depositor),
        Err(Ok(EscrowError::ReentrancyDetected))
    );
    assert_eq!(
        h.client().try_refund(&31, &h.arbiter),
        Err(Ok(EscrowError::ReentrancyDetected))
    );
}
