#![no_std]

use soroban_sdk::{
    contractclient, contracterror, contracttype, symbol_short, Address, BytesN, Env,
};

/// Required timelock duration before a proposed WASM upgrade can be executed.
/// Enforces a 48-hour delay (172,800 seconds).
pub const TIMELOCK_DELAY_SECONDS: u64 = 48 * 60 * 60;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UpgradeError {
    /// Caller is not the authorized contract administrator.
    NotAdmin = 1,
    /// Contract admin has already been initialized.
    AlreadyInitialized = 2,
    /// Contract admin has not been initialized.
    NotInitialized = 3,
    /// No upgrade proposal is currently pending.
    NoUpgradePending = 4,
    /// 48-hour timelock has not expired yet.
    TimelockNotExpired = 5,
    /// Provided WASM hash does not match the pending proposal.
    HashMismatch = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpgradeDataKey {
    Admin,
    CurrentWasmHash,
    PendingUpgrade,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposal {
    pub new_wasm_hash: BytesN<32>,
    pub proposed_at: u64,
    pub unlock_at: u64,
}

/// Helper struct providing reusable upgrade and admin management methods.
pub struct UpgradeManager;

impl UpgradeManager {
    /// Initialize the contract administrator and initial WASM hash.
    /// Can only be called once.
    pub fn init(
        env: &Env,
        admin: &Address,
        initial_wasm_hash: &BytesN<32>,
    ) -> Result<(), UpgradeError> {
        if env.storage().instance().has(&UpgradeDataKey::Admin) {
            return Err(UpgradeError::AlreadyInitialized);
        }
        env.storage().instance().set(&UpgradeDataKey::Admin, admin);
        env.storage()
            .instance()
            .set(&UpgradeDataKey::CurrentWasmHash, initial_wasm_hash);
        Ok(())
    }

    /// Check if a given caller is the active administrator.
    pub fn is_admin(env: &Env, caller: &Address) -> bool {
        match env.storage().instance().get::<_, Address>(&UpgradeDataKey::Admin) {
            Some(admin) => &admin == caller,
            None => false,
        }
    }

    /// Require caller authorization and assert they are the administrator.
    pub fn assert_admin(env: &Env, caller: &Address) -> Result<(), UpgradeError> {
        caller.require_auth();
        if !Self::is_admin(env, caller) {
            return Err(UpgradeError::NotAdmin);
        }
        Ok(())
    }

    /// Retrieve the current administrator address.
    pub fn get_admin(env: &Env) -> Result<Address, UpgradeError> {
        env.storage()
            .instance()
            .get::<_, Address>(&UpgradeDataKey::Admin)
            .ok_or(UpgradeError::NotInitialized)
    }

    /// Update the administrator address, gated by current admin authorization.
    pub fn set_admin(
        env: &Env,
        current_admin: &Address,
        new_admin: &Address,
    ) -> Result<(), UpgradeError> {
        Self::assert_admin(env, current_admin)?;
        env.storage().instance().set(&UpgradeDataKey::Admin, new_admin);
        env.events().publish(
            (symbol_short!("set_adm"), current_admin.clone()),
            new_admin.clone(),
        );
        Ok(())
    }

    /// Retrieve the tracked current WASM hash of the contract.
    pub fn get_current_wasm_hash(env: &Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get::<_, BytesN<32>>(&UpgradeDataKey::CurrentWasmHash)
            .unwrap_or_else(|| BytesN::from_array(env, &[0u8; 32]))
    }

    /// Retrieve the currently pending upgrade proposal, if any.
    pub fn get_pending_upgrade(env: &Env) -> Option<UpgradeProposal> {
        env.storage()
            .instance()
            .get::<_, UpgradeProposal>(&UpgradeDataKey::PendingUpgrade)
    }

    /// Propose a new WASM hash for code upgrade.
    /// Initiates a 48-hour timelock countdown.
    pub fn propose_upgrade(
        env: &Env,
        admin: &Address,
        new_wasm_hash: &BytesN<32>,
    ) -> Result<u64, UpgradeError> {
        Self::assert_admin(env, admin)?;

        let now = env.ledger().timestamp();
        let unlock_at = now + TIMELOCK_DELAY_SECONDS;

        let proposal = UpgradeProposal {
            new_wasm_hash: new_wasm_hash.clone(),
            proposed_at: now,
            unlock_at,
        };

        env.storage()
            .instance()
            .set(&UpgradeDataKey::PendingUpgrade, &proposal);

        // Emit proposal event with target hash and unlock timestamp
        env.events().publish(
            (symbol_short!("propose"), admin.clone()),
            (new_wasm_hash.clone(), unlock_at),
        );

        Ok(unlock_at)
    }

    /// Cancel a pending upgrade proposal.
    pub fn cancel_upgrade(env: &Env, admin: &Address) -> Result<(), UpgradeError> {
        Self::assert_admin(env, admin)?;

        if let Some(proposal) = Self::get_pending_upgrade(env) {
            env.storage()
                .instance()
                .remove(&UpgradeDataKey::PendingUpgrade);
            env.events().publish(
                (symbol_short!("cancel"), admin.clone()),
                proposal.new_wasm_hash,
            );
            Ok(())
        } else {
            Err(UpgradeError::NoUpgradePending)
        }
    }

    /// Execute the code upgrade after the 48-hour timelock has elapsed.
    ///
    /// - Checks admin authorization.
    /// - Verifies that a proposal exists and matches `new_wasm_hash`.
    /// - Enforces that `env.ledger().timestamp() >= proposal.unlock_at`.
    /// - Replaces contract bytecode using `env.deployer().update_current_contract_wasm()`.
    /// - Emits `upgrade` event with `(old_wasm_hash, new_wasm_hash)`.
    pub fn upgrade(
        env: &Env,
        admin: &Address,
        new_wasm_hash: &BytesN<32>,
    ) -> Result<(), UpgradeError> {
        Self::assert_admin(env, admin)?;

        let proposal = match Self::get_pending_upgrade(env) {
            Some(p) => p,
            None => {
                // If no proposal has been scheduled yet, schedule one and enforce 48-hour timelock
                Self::propose_upgrade(env, admin, new_wasm_hash)?;
                return Err(UpgradeError::TimelockNotExpired);
            }
        };

        if &proposal.new_wasm_hash != new_wasm_hash {
            return Err(UpgradeError::HashMismatch);
        }

        let now = env.ledger().timestamp();
        if now < proposal.unlock_at {
            return Err(UpgradeError::TimelockNotExpired);
        }

        let old_wasm_hash = Self::get_current_wasm_hash(env);

        // Update contract bytecode via Soroban deployer
        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());

        // Update recorded WASM hash and clear pending proposal
        env.storage()
            .instance()
            .set(&UpgradeDataKey::CurrentWasmHash, new_wasm_hash);
        env.storage()
            .instance()
            .remove(&UpgradeDataKey::PendingUpgrade);

        // Emit upgrade event: topic = (symbol_short!("upgrade"), admin), data = (old_wasm_hash, new_wasm_hash)
        env.events().publish(
            (symbol_short!("upgrade"), admin.clone()),
            (old_wasm_hash, new_wasm_hash.clone()),
        );

        Ok(())
    }
}

// Top-level module convenience functions
pub fn init_admin(env: &Env, admin: &Address, initial_wasm_hash: &BytesN<32>) -> Result<(), UpgradeError> {
    UpgradeManager::init(env, admin, initial_wasm_hash)
}

pub fn is_admin(env: &Env, caller: &Address) -> bool {
    UpgradeManager::is_admin(env, caller)
}

pub fn get_admin(env: &Env) -> Result<Address, UpgradeError> {
    UpgradeManager::get_admin(env)
}

pub fn set_admin(env: &Env, current_admin: &Address, new_admin: &Address) -> Result<(), UpgradeError> {
    UpgradeManager::set_admin(env, current_admin, new_admin)
}

pub fn propose_upgrade(env: &Env, admin: &Address, new_wasm_hash: &BytesN<32>) -> Result<u64, UpgradeError> {
    UpgradeManager::propose_upgrade(env, admin, new_wasm_hash)
}

pub fn get_pending_upgrade(env: &Env) -> Option<UpgradeProposal> {
    UpgradeManager::get_pending_upgrade(env)
}

pub fn cancel_upgrade(env: &Env, admin: &Address) -> Result<(), UpgradeError> {
    UpgradeManager::cancel_upgrade(env, admin)
}

pub fn upgrade(env: &Env, admin: &Address, new_wasm_hash: &BytesN<32>) -> Result<(), UpgradeError> {
    UpgradeManager::upgrade(env, admin, new_wasm_hash)
}

/// Standard interface trait that upgradeable contracts can implement.
#[contractclient(name = "UpgradeableClient")]
pub trait Upgradeable {
    /// Initialize admin role and initial WASM hash.
    fn init(env: Env, admin: Address, initial_wasm_hash: BytesN<32>);

    /// Returns the current admin address.
    fn get_admin(env: Env) -> Address;

    /// Update administrator.
    fn set_admin(env: Env, current_admin: Address, new_admin: Address);

    /// Propose a new code hash with 48h timelock. Returns unlock timestamp.
    fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64;

    /// Cancel a pending upgrade proposal.
    fn cancel_upgrade(env: Env, admin: Address);

    /// Returns current pending upgrade, if any.
    fn get_pending_upgrade(env: Env) -> Option<UpgradeProposal>;

    /// Returns current WASM hash.
    fn get_wasm_hash(env: Env) -> BytesN<32>;

    /// Execute upgrade. Gated by admin auth and 48-hour timelock.
    fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>);
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Events, Ledger},
        vec, Address, BytesN, Env, IntoVal,
    };

    #[contract]
    pub struct MockUpgradeableContract;

    #[contractimpl]
    impl Upgradeable for MockUpgradeableContract {
        fn init(env: Env, admin: Address, initial_wasm_hash: BytesN<32>) {
            UpgradeManager::init(&env, &admin, &initial_wasm_hash).unwrap();
        }

        fn get_admin(env: Env) -> Address {
            UpgradeManager::get_admin(&env).unwrap()
        }

        fn set_admin(env: Env, current_admin: Address, new_admin: Address) {
            UpgradeManager::set_admin(&env, &current_admin, &new_admin).unwrap();
        }

        fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
            UpgradeManager::propose_upgrade(&env, &admin, &new_wasm_hash).unwrap()
        }

        fn cancel_upgrade(env: Env, admin: Address) {
            UpgradeManager::cancel_upgrade(&env, &admin).unwrap();
        }

        fn get_pending_upgrade(env: Env) -> Option<UpgradeProposal> {
            UpgradeManager::get_pending_upgrade(&env)
        }

        fn get_wasm_hash(env: Env) -> BytesN<32> {
            UpgradeManager::get_current_wasm_hash(&env)
        }

        fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) {
            UpgradeManager::upgrade(&env, &admin, &new_wasm_hash).unwrap();
        }
    }

    fn setup_env() -> (Env, Address, Address, MockUpgradeableContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(MockUpgradeableContract, ());
        let client = MockUpgradeableContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);

        let initial_wasm = BytesN::from_array(&env, &[1u8; 32]);
        client.init(&admin, &initial_wasm);

        (env, admin, attacker, client)
    }

    #[test]
    fn test_admin_initialization_and_reinitialization() {
        let (env, admin, _, client) = setup_env();
        assert_eq!(client.get_admin(), admin);

        // Reinitialization must fail
        let duplicate_admin = Address::generate(&env);
        let new_hash = BytesN::from_array(&env, &[2u8; 32]);
        let res = client.try_init(&duplicate_admin, &new_hash);
        assert!(res.is_err());
    }

    #[test]
    fn test_set_admin_role() {
        let (env, admin, _, client) = setup_env();
        let new_admin = Address::generate(&env);

        client.set_admin(&admin, &new_admin);
        assert_eq!(client.get_admin(), new_admin);
    }

    #[test]
    fn test_propose_upgrade_records_timelock_and_emits_event() {
        let (env, admin, _, client) = setup_env();
        let new_wasm = BytesN::from_array(&env, &[2u8; 32]);

        let start_time = 100_000u64;
        env.ledger().set_timestamp(start_time);

        let unlock_at = client.propose_upgrade(&admin, &new_wasm);
        assert_eq!(unlock_at, start_time + TIMELOCK_DELAY_SECONDS);

        let pending = client.get_pending_upgrade().unwrap();
        assert_eq!(pending.new_wasm_hash, new_wasm);
        assert_eq!(pending.proposed_at, start_time);
        assert_eq!(pending.unlock_at, start_time + TIMELOCK_DELAY_SECONDS);
    }

    #[test]
    fn test_upgrade_fails_before_48h_timelock_expires() {
        let (env, admin, _, client) = setup_env();
        let new_wasm = BytesN::from_array(&env, &[2u8; 32]);

        let start_time = 1_000_000u64;
        env.ledger().set_timestamp(start_time);

        client.propose_upgrade(&admin, &new_wasm);

        // Advance 24 hours (less than 48 hours required)
        env.ledger().set_timestamp(start_time + 24 * 3600);

        let res = client.try_upgrade(&admin, &new_wasm);
        assert!(res.is_err());
    }

    #[test]
    fn test_cancel_upgrade_clears_pending_proposal() {
        let (env, admin, _, client) = setup_env();
        let new_wasm = BytesN::from_array(&env, &[2u8; 32]);

        client.propose_upgrade(&admin, &new_wasm);
        assert!(client.get_pending_upgrade().is_some());

        client.cancel_upgrade(&admin);
        assert!(client.get_pending_upgrade().is_none());
    }

    #[test]
    fn test_upgrade_hash_mismatch_fails() {
        let (env, admin, _, client) = setup_env();
        let proposed_wasm = BytesN::from_array(&env, &[2u8; 32]);
        let different_wasm = BytesN::from_array(&env, &[3u8; 32]);

        let start_time = 1_000_000u64;
        env.ledger().set_timestamp(start_time);

        client.propose_upgrade(&admin, &proposed_wasm);

        // Advance past timelock
        env.ledger().set_timestamp(start_time + TIMELOCK_DELAY_SECONDS + 1);

        // Attempt upgrade with mismatched hash
        let res = client.try_upgrade(&admin, &different_wasm);
        assert!(res.is_err());
    }
}
