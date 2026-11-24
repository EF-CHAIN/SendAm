#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN, Env,
};

const INSTANCE_LIFETIME_THRESHOLD: u32 = 17_280;
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 17_280;
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AttestationError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    UnauthorizedSigner = 3,
    InvalidExpiration = 4,
    AttestationNotFound = 5,
    AlreadyRevoked = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationRecord {
    pub identity_hash: BytesN<32>,
    pub account: Address,
    pub issued_by: Address,
    pub issued_at: u64,
    pub expires_at: u64,
    pub revoked: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Admin,
    Signer(Address),
    Attestation(BytesN<32>),
    AccountHash(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerAdded {
    #[topic]
    pub signer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerRemoved {
    #[topic]
    pub signer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationIssued {
    #[topic]
    pub identity_hash: BytesN<32>,
    pub account: Address,
    pub expires_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationRevoked {
    #[topic]
    pub identity_hash: BytesN<32>,
    pub revoked_by: Address,
}

#[contract]
pub struct AttestationRegistryContract;

impl AttestationRegistryContract {
    fn require_admin(env: &Env) -> Result<Address, AttestationError> {
        let admin = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Admin)
            .ok_or(AttestationError::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
    }

    fn require_compliance_signer(env: &Env, signer: &Address) -> Result<(), AttestationError> {
        signer.require_auth();
        let authorized = env
            .storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Signer(signer.clone()))
            .unwrap_or(false);
        if !authorized {
            return Err(AttestationError::UnauthorizedSigner);
        }
        Ok(())
    }

    fn record_is_active(env: &Env, record: &AttestationRecord) -> bool {
        !record.revoked && env.ledger().timestamp() < record.expires_at
    }
}

#[contractimpl]
impl AttestationRegistryContract {
    /// Initializes the attestation registry with a contract administrator.
    pub fn initialize(env: Env, admin: Address) -> Result<(), AttestationError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(AttestationError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Authorizes a compliance signer to write and revoke identity attestations.
    pub fn add_signer(env: Env, signer: Address) -> Result<(), AttestationError> {
        Self::require_admin(&env)?;

        let key = DataKey::Signer(signer.clone());
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        SignerAdded { signer }.publish(&env);
        Ok(())
    }

    /// Revokes a compliance signer's write permissions.
    pub fn remove_signer(env: Env, signer: Address) -> Result<(), AttestationError> {
        Self::require_admin(&env)?;

        let key = DataKey::Signer(signer.clone());
        env.storage().persistent().remove(&key);

        SignerRemoved { signer }.publish(&env);
        Ok(())
    }

    /// Returns `true` if `address` is currently an authorized compliance signer.
    pub fn is_signer(env: Env, address: Address) -> bool {
        env.storage()
            .persistent()
            .get::<DataKey, bool>(&DataKey::Signer(address))
            .unwrap_or(false)
    }

    /// Returns the contract administrator address.
    pub fn get_admin(env: Env) -> Result<Address, AttestationError> {
        env.storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Admin)
            .ok_or(AttestationError::NotInitialized)
    }

    /// Computes the canonical `SHA-256(phone_bytes || salt)` identity hash on-chain.
    pub fn compute_identity_hash(env: Env, phone_bytes: Bytes, salt: Bytes) -> BytesN<32> {
        let mut payload = Bytes::new(&env);
        payload.append(&phone_bytes);
        payload.append(&salt);
        env.crypto().sha256(&payload).into()
    }

    /// Issues or renews an attestation mapping a salted phone-number hash to a Stellar
    /// public key (`account`) with an expiration timestamp. Only authorized compliance
    /// signers may call this method.
    pub fn attest(
        env: Env,
        signer: Address,
        identity_hash: BytesN<32>,
        account: Address,
        expires_at: u64,
    ) -> Result<AttestationRecord, AttestationError> {
        Self::require_compliance_signer(&env, &signer)?;

        let now = env.ledger().timestamp();
        if expires_at <= now {
            return Err(AttestationError::InvalidExpiration);
        }

        let key = DataKey::Attestation(identity_hash.clone());
        if let Some(previous) = env
            .storage()
            .persistent()
            .get::<DataKey, AttestationRecord>(&key)
        {
            if previous.account != account {
                env.storage()
                    .persistent()
                    .remove(&DataKey::AccountHash(previous.account));
            }
        }

        let record = AttestationRecord {
            identity_hash: identity_hash.clone(),
            account: account.clone(),
            issued_by: signer,
            issued_at: now,
            expires_at,
            revoked: false,
        };

        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let account_key = DataKey::AccountHash(account.clone());
        env.storage().persistent().set(&account_key, &identity_hash);
        env.storage().persistent().extend_ttl(
            &account_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        AttestationIssued {
            identity_hash,
            account,
            expires_at,
        }
        .publish(&env);

        Ok(record)
    }

    /// Revokes an existing identity attestation. Only authorized compliance signers
    /// may call this method.
    pub fn revoke(
        env: Env,
        signer: Address,
        identity_hash: BytesN<32>,
    ) -> Result<(), AttestationError> {
        Self::require_compliance_signer(&env, &signer)?;

        let key = DataKey::Attestation(identity_hash.clone());
        let mut record = env
            .storage()
            .persistent()
            .get::<DataKey, AttestationRecord>(&key)
            .ok_or(AttestationError::AttestationNotFound)?;

        if record.revoked {
            return Err(AttestationError::AlreadyRevoked);
        }

        record.revoked = true;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        AttestationRevoked {
            identity_hash,
            revoked_by: signer,
        }
        .publish(&env);

        Ok(())
    }

    /// Trustless read method returning the attestation record for `identity_hash`, if present.
    pub fn get_attestation(env: Env, identity_hash: BytesN<32>) -> Option<AttestationRecord> {
        env.storage()
            .persistent()
            .get::<DataKey, AttestationRecord>(&DataKey::Attestation(identity_hash))
    }

    /// Trustless read method returning the attestation record associated with `account`, if any.
    pub fn get_attestation_by_account(env: Env, account: Address) -> Option<AttestationRecord> {
        let identity_hash = env
            .storage()
            .persistent()
            .get::<DataKey, BytesN<32>>(&DataKey::AccountHash(account))?;
        Self::get_attestation(env, identity_hash)
    }

    /// Trustless verification checking whether `identity_hash` is currently active
    /// (not revoked and not expired).
    pub fn is_valid(env: Env, identity_hash: BytesN<32>) -> bool {
        match Self::get_attestation(env.clone(), identity_hash) {
            Some(record) => Self::record_is_active(&env, &record),
            None => false,
        }
    }

    /// Trustless verification checking whether `identity_hash` is actively attested to `account`.
    pub fn verify_identity(env: Env, identity_hash: BytesN<32>, account: Address) -> bool {
        match Self::get_attestation(env.clone(), identity_hash) {
            Some(record) => record.account == account && Self::record_is_active(&env, &record),
            None => false,
        }
    }

    /// Trustless verification computing `SHA-256(phone_bytes || salt)` and checking
    /// whether the resulting identity hash is actively attested to `account`.
    pub fn verify_phone_with_salt(
        env: Env,
        phone_bytes: Bytes,
        salt: Bytes,
        account: Address,
    ) -> bool {
        let identity_hash = Self::compute_identity_hash(env.clone(), phone_bytes, salt);
        Self::verify_identity(env, identity_hash, account)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup_env() -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.timestamp = 10_000;
            li.sequence_number = 500;
        });
        env.mock_all_auths();

        let contract_id = env.register(AttestationRegistryContract, ());
        let admin = Address::generate(&env);
        let signer = Address::generate(&env);
        let customer = Address::generate(&env);
        let outsider = Address::generate(&env);

        let client = AttestationRegistryContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        client.add_signer(&signer);

        (env, contract_id, admin, signer, customer, outsider)
    }

    #[test]
    fn test_attest_and_trustless_verification() {
        let (env, contract_id, _, signer, customer, outsider) = setup_env();
        let client = AttestationRegistryContractClient::new(&env, &contract_id);

        let phone = Bytes::from_slice(&env, b"+2348012345678");
        let salt = Bytes::from_slice(&env, b"sendam-v1-salt-9f8e7d");
        let hash = client.compute_identity_hash(&phone, &salt);

        let record = client.attest(&signer, &hash, &customer, &20_000);
        assert_eq!(record.identity_hash, hash);
        assert_eq!(record.account, customer);
        assert_eq!(record.issued_by, signer);
        assert_eq!(record.issued_at, 10_000);
        assert_eq!(record.expires_at, 20_000);
        assert!(!record.revoked);

        // Trustless read methods succeed without any authorization.
        env.set_auths(&[]);
        assert!(client.is_valid(&hash));
        assert!(client.verify_identity(&hash, &customer));
        assert!(client.verify_phone_with_salt(&phone, &salt, &customer));
        assert!(!client.verify_identity(&hash, &outsider));

        // Wrong salt fails verification.
        let wrong_salt = Bytes::from_slice(&env, b"wrong-salt");
        assert!(!client.verify_phone_with_salt(&phone, &wrong_salt, &customer));

        // Reverse lookup by account succeeds.
        let by_account = client.get_attestation_by_account(&customer);
        assert_eq!(by_account, Some(record));
    }

    #[test]
    fn test_only_authorized_compliance_signers_can_write_or_revoke() {
        let (env, contract_id, _, signer, customer, outsider) = setup_env();
        let client = AttestationRegistryContractClient::new(&env, &contract_id);

        let phone = Bytes::from_slice(&env, b"+233201234567");
        let salt = Bytes::from_slice(&env, b"salt-abc");
        let hash = client.compute_identity_hash(&phone, &salt);

        // Unauthorized signer cannot attest.
        assert_eq!(
            client.try_attest(&outsider, &hash, &customer, &20_000),
            Err(Ok(AttestationError::UnauthorizedSigner))
        );

        // Authorized signer attests.
        client.attest(&signer, &hash, &customer, &20_000);

        // Unauthorized signer cannot revoke.
        assert_eq!(
            client.try_revoke(&outsider, &hash),
            Err(Ok(AttestationError::UnauthorizedSigner))
        );
        assert!(client.is_valid(&hash));

        // Removing signer revokes their ability to write.
        client.remove_signer(&signer);
        assert!(!client.is_signer(&signer));
        assert_eq!(
            client.try_revoke(&signer, &hash),
            Err(Ok(AttestationError::UnauthorizedSigner))
        );
    }

    #[test]
    fn test_expiration_and_revocation_invalidate_attestation() {
        let (env, contract_id, _, signer, customer, _) = setup_env();
        let client = AttestationRegistryContractClient::new(&env, &contract_id);

        let hash_a = client.compute_identity_hash(
            &Bytes::from_slice(&env, b"+254700000001"),
            &Bytes::from_slice(&env, b"salt-1"),
        );
        let hash_b = client.compute_identity_hash(
            &Bytes::from_slice(&env, b"+254700000002"),
            &Bytes::from_slice(&env, b"salt-2"),
        );

        client.attest(&signer, &hash_a, &customer, &15_000);
        client.attest(&signer, &hash_b, &customer, &30_000);

        // Advance ledger to 15_000: hash_a expires, hash_b remains valid.
        env.ledger().with_mut(|li| li.timestamp = 15_000);
        assert!(!client.is_valid(&hash_a));
        assert!(!client.verify_identity(&hash_a, &customer));
        assert!(client.is_valid(&hash_b));

        // Revoking hash_b immediately invalidates it.
        client.revoke(&signer, &hash_b);
        assert!(!client.is_valid(&hash_b));
        assert!(!client.verify_identity(&hash_b, &customer));

        // Double revocation fails.
        assert_eq!(
            client.try_revoke(&signer, &hash_b),
            Err(Ok(AttestationError::AlreadyRevoked))
        );
    }

    #[test]
    fn test_reassignment_updates_reverse_account_index() {
        let (env, contract_id, _, signer, customer, new_account) = setup_env();
        let client = AttestationRegistryContractClient::new(&env, &contract_id);

        let hash = client.compute_identity_hash(
            &Bytes::from_slice(&env, b"+2348099999999"),
            &Bytes::from_slice(&env, b"salt-rotate"),
        );

        client.attest(&signer, &hash, &customer, &20_000);
        assert!(client.verify_identity(&hash, &customer));

        // Re-attest same phone hash to a rotated Stellar account.
        client.attest(&signer, &hash, &new_account, &25_000);
        assert!(!client.verify_identity(&hash, &customer));
        assert!(client.verify_identity(&hash, &new_account));
        assert_eq!(client.get_attestation_by_account(&customer), None);
        assert!(client.get_attestation_by_account(&new_account).is_some());
    }

    #[test]
    fn test_validation_and_initialization_errors() {
        let (env, contract_id, admin, signer, customer, _) = setup_env();
        let client = AttestationRegistryContractClient::new(&env, &contract_id);

        assert_eq!(client.get_admin(), admin);
        assert_eq!(
            client.try_initialize(&admin),
            Err(Ok(AttestationError::AlreadyInitialized))
        );

        let hash = client.compute_identity_hash(
            &Bytes::from_slice(&env, b"+2348000000000"),
            &Bytes::from_slice(&env, b"salt-0"),
        );

        // Expiration <= current ledger timestamp rejected.
        assert_eq!(
            client.try_attest(&signer, &hash, &customer, &10_000),
            Err(Ok(AttestationError::InvalidExpiration))
        );
        assert_eq!(
            client.try_attest(&signer, &hash, &customer, &9_999),
            Err(Ok(AttestationError::InvalidExpiration))
        );

        // Revoking non-existent attestation fails.
        assert_eq!(
            client.try_revoke(&signer, &hash),
            Err(Ok(AttestationError::AttestationNotFound))
        );
    }

    #[test]
    #[should_panic(expected = "Error(Auth, InvalidAction)")]
    fn test_attest_requires_signer_signature() {
        let (env, contract_id, _, signer, customer, _) = setup_env();
        let client = AttestationRegistryContractClient::new(&env, &contract_id);

        let hash = client.compute_identity_hash(
            &Bytes::from_slice(&env, b"+2348011111111"),
            &Bytes::from_slice(&env, b"salt-auth"),
        );

        env.set_auths(&[]);
        client.attest(&signer, &hash, &customer, &20_000);
    }

    #[test]
    #[should_panic(expected = "Error(Auth, InvalidAction)")]
    fn test_add_signer_requires_admin_auth() {
        let (env, contract_id, _, _, _, outsider) = setup_env();
        let client = AttestationRegistryContractClient::new(&env, &contract_id);

        env.set_auths(&[]);
        client.add_signer(&outsider);
    }

    #[test]
    fn test_renew_expired_attestation_and_unknown_hash() {
        let (env, contract_id, _, signer, customer, _) = setup_env();
        let client = AttestationRegistryContractClient::new(&env, &contract_id);

        let unknown_hash = client.compute_identity_hash(
            &Bytes::from_slice(&env, b"+000000000000"),
            &Bytes::from_slice(&env, b"none"),
        );
        assert!(!client.is_valid(&unknown_hash));
        assert!(!client.verify_identity(&unknown_hash, &customer));

        let hash = client.compute_identity_hash(
            &Bytes::from_slice(&env, b"+2348055555555"),
            &Bytes::from_slice(&env, b"salt-renew"),
        );
        client.attest(&signer, &hash, &customer, &12_000);
        env.ledger().with_mut(|li| li.timestamp = 12_000);
        assert!(!client.is_valid(&hash));

        // Signer renews attestation with a new future expiration.
        client.attest(&signer, &hash, &customer, &25_000);
        assert!(client.is_valid(&hash));
        assert!(client.verify_identity(&hash, &customer));
    }
}
