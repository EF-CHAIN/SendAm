use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, xdr::ToXdr, Address, Bytes,
    BytesN, Env, IntoVal, Symbol, Val, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SmartWalletError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidKeyLength = 3,
    SignerAlreadyExists = 4,
    SignerNotFound = 5,
    CannotRemoveLastSigner = 6,
    InvalidSignature = 7,
    InvalidNonce = 8,
    Unauthorized = 9,
    WalletAlreadyDeployed = 10,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SignerKey {
    /// Ed25519 32-byte public key.
    Ed25519(BytesN<32>),
    /// NIST P-256 (secp256r1) 65-byte uncompressed SEC1 public key (`0x04 || X || Y`) used by WebAuthn passkeys.
    Secp256r1(BytesN<65>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SignaturePayload {
    /// Raw Ed25519 64-byte signature over the message digest.
    Ed25519(BytesN<64>),
    /// Raw secp256r1 64-byte `(r || s)` compact signature over the message digest.
    Secp256r1(BytesN<64>),
    /// Full WebAuthn assertion payload (`authenticator_data`, `client_data_json`, 64-byte `(r || s)` signature).
    /// Verifies `SHA256(authenticator_data || SHA256(client_data_json))` with the secp256r1 public key.
    WebAuthn(WebAuthnSignature),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebAuthnSignature {
    pub authenticator_data: Bytes,
    pub client_data_json: Bytes,
    pub signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedInvocation {
    pub target: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    pub nonce: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WalletDataKey {
    Initialized,
    Signers,
    Nonce,
}

#[contractevent(topics = ["wallet", "init"])]
pub struct WalletInitializedEvent {
    pub signer: SignerKey,
}

#[contractevent(topics = ["wallet", "add_key"])]
pub struct SignerAddedEvent {
    pub signer: SignerKey,
}

#[contractevent(topics = ["wallet", "rm_key"])]
pub struct SignerRemovedEvent {
    pub signer: SignerKey,
}

#[contractevent(topics = ["wallet", "exec"])]
pub struct WalletExecutedEvent {
    pub target: Address,
    pub function: Symbol,
    pub nonce: u64,
}

pub fn validate_signer_key(signer: &SignerKey) -> Result<(), SmartWalletError> {
    match signer {
        SignerKey::Ed25519(_) => Ok(()),
        SignerKey::Secp256r1(pk) => {
            // Uncompressed SEC1 point must start with 0x04
            if pk.get(0) != Some(0x04) {
                return Err(SmartWalletError::InvalidKeyLength);
            }
            Ok(())
        }
    }
}

pub fn verify_signer_signature(
    env: &Env,
    signer: &SignerKey,
    payload: &Bytes,
    signature: &SignaturePayload,
) -> Result<(), SmartWalletError> {
    match (signer, signature) {
        (SignerKey::Ed25519(public_key), SignaturePayload::Ed25519(sig)) => {
            env.crypto().ed25519_verify(public_key, payload, sig);
            Ok(())
        }
        (SignerKey::Secp256r1(public_key), SignaturePayload::Secp256r1(sig)) => {
            let digest = env.crypto().sha256(payload);
            env.crypto().secp256r1_verify(public_key, &digest, sig);
            Ok(())
        }
        (SignerKey::Secp256r1(public_key), SignaturePayload::WebAuthn(webauthn)) => {
            // Authenticator data must be at least 37 bytes per WebAuthn specification
            if webauthn.authenticator_data.len() < 37 {
                return Err(SmartWalletError::InvalidSignature);
            }
            // Verify user presence (UP) bit (bit 0 of flags byte at index 32)
            let flags = webauthn
                .authenticator_data
                .get(32)
                .ok_or(SmartWalletError::InvalidSignature)?;
            if (flags & 0x01) == 0 {
                return Err(SmartWalletError::InvalidSignature);
            }

            // Ensure the challenge or payload binding is present in client_data_json
            let expected_challenge_hash: Bytes = env.crypto().sha256(payload).to_bytes().into();
            if !contains_subslice(&webauthn.client_data_json, &expected_challenge_hash)
                && !contains_subslice(&webauthn.client_data_json, payload)
            {
                return Err(SmartWalletError::InvalidSignature);
            }

            let client_data_hash: Bytes = env
                .crypto()
                .sha256(&webauthn.client_data_json)
                .to_bytes()
                .into();
            let mut signed_data = webauthn.authenticator_data.clone();
            signed_data.append(&client_data_hash);
            let message_digest = env.crypto().sha256(&signed_data);

            env.crypto()
                .secp256r1_verify(public_key, &message_digest, &webauthn.signature);
            Ok(())
        }
        _ => Err(SmartWalletError::InvalidSignature),
    }
}

fn contains_subslice(haystack: &Bytes, needle: &Bytes) -> bool {
    let h_len = haystack.len();
    let n_len = needle.len();
    if n_len == 0 || n_len > h_len {
        return false;
    }
    for start in 0..=(h_len - n_len) {
        let mut matched = true;
        for i in 0..n_len {
            if haystack.get(start + i) != needle.get(i) {
                matched = false;
                break;
            }
        }
        if matched {
            return true;
        }
    }
    false
}

pub fn build_execution_payload(
    env: &Env,
    wallet_address: &Address,
    target: &Address,
    function: &Symbol,
    args: &Vec<Val>,
    nonce: u64,
) -> Bytes {
    let invocation = (
        wallet_address.clone(),
        target.clone(),
        function.clone(),
        args.clone(),
        nonce,
    );
    let val: Val = invocation.into_val(env);
    val.to_xdr(env)
}

#[contract]
pub struct SmartWalletContract;

#[contractimpl]
impl SmartWalletContract {
    /// Initialize the smart wallet account with an initial verification key (secp256r1 or ed25519).
    pub fn init(env: Env, initial_signer: SignerKey) -> Result<(), SmartWalletError> {
        if env.storage().instance().has(&WalletDataKey::Initialized) {
            return Err(SmartWalletError::AlreadyInitialized);
        }
        validate_signer_key(&initial_signer)?;

        let mut signers = Vec::new(&env);
        signers.push_back(initial_signer.clone());

        env.storage()
            .instance()
            .set(&WalletDataKey::Initialized, &true);
        env.storage()
            .instance()
            .set(&WalletDataKey::Signers, &signers);
        env.storage().instance().set(&WalletDataKey::Nonce, &0u64);

        WalletInitializedEvent {
            signer: initial_signer,
        }
        .publish(&env);
        Ok(())
    }

    /// Add an additional verification key (e.g. backup device passkey or recovery ed25519 signer).
    /// Must be authorized by an existing signer via `execute` or `require_auth` on the wallet contract itself.
    pub fn add_signer(env: Env, signer: SignerKey) -> Result<(), SmartWalletError> {
        Self::require_initialized(&env)?;
        env.current_contract_address().require_auth();
        validate_signer_key(&signer)?;

        let mut signers: Vec<SignerKey> = env
            .storage()
            .instance()
            .get(&WalletDataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));

        if signers.contains(&signer) {
            return Err(SmartWalletError::SignerAlreadyExists);
        }

        signers.push_back(signer.clone());
        env.storage()
            .instance()
            .set(&WalletDataKey::Signers, &signers);

        SignerAddedEvent { signer }.publish(&env);
        Ok(())
    }

    /// Remove a verification key. Cannot remove the last remaining signer.
    pub fn remove_signer(env: Env, signer: SignerKey) -> Result<(), SmartWalletError> {
        Self::require_initialized(&env)?;
        env.current_contract_address().require_auth();

        let signers: Vec<SignerKey> = env
            .storage()
            .instance()
            .get(&WalletDataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));

        if signers.len() <= 1 {
            return Err(SmartWalletError::CannotRemoveLastSigner);
        }

        let mut updated = Vec::new(&env);
        let mut found = false;
        for s in signers.iter() {
            if s == signer {
                found = true;
            } else {
                updated.push_back(s);
            }
        }

        if !found {
            return Err(SmartWalletError::SignerNotFound);
        }

        env.storage()
            .instance()
            .set(&WalletDataKey::Signers, &updated);

        SignerRemovedEvent { signer }.publish(&env);
        Ok(())
    }

    /// Return all registered verification keys for this smart wallet.
    pub fn get_signers(env: Env) -> Result<Vec<SignerKey>, SmartWalletError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&WalletDataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env)))
    }

    /// Return the current replay-protection nonce.
    pub fn get_nonce(env: Env) -> Result<u64, SmartWalletError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&WalletDataKey::Nonce)
            .unwrap_or(0u64))
    }

    /// Verify a signature against a registered signer key and arbitrary message payload.
    pub fn verify_signature(
        env: Env,
        signer: SignerKey,
        payload: Bytes,
        signature: SignaturePayload,
    ) -> Result<bool, SmartWalletError> {
        Self::require_initialized(&env)?;
        let signers: Vec<SignerKey> = env
            .storage()
            .instance()
            .get(&WalletDataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));

        if !signers.contains(&signer) {
            return Err(SmartWalletError::SignerNotFound);
        }

        verify_signer_signature(&env, &signer, &payload, &signature)?;
        Ok(true)
    }

    /// Execute a transaction call on a target contract after verifying the passkey/ed25519 signature
    /// and advancing the wallet's replay-protection nonce.
    pub fn execute(
        env: Env,
        target: Address,
        function: Symbol,
        args: Vec<Val>,
        signer: SignerKey,
        signature: SignaturePayload,
    ) -> Result<Val, SmartWalletError> {
        Self::require_initialized(&env)?;

        let signers: Vec<SignerKey> = env
            .storage()
            .instance()
            .get(&WalletDataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));

        if !signers.contains(&signer) {
            return Err(SmartWalletError::SignerNotFound);
        }

        let current_nonce: u64 = env
            .storage()
            .instance()
            .get(&WalletDataKey::Nonce)
            .unwrap_or(0u64);

        let payload = Self::execution_payload(
            env.clone(),
            target.clone(),
            function.clone(),
            args.clone(),
            current_nonce,
        );

        verify_signer_signature(&env, &signer, &payload, &signature)?;

        let next_nonce = current_nonce + 1;
        env.storage()
            .instance()
            .set(&WalletDataKey::Nonce, &next_nonce);

        let result: Val = env.invoke_contract(&target, &function, args);

        WalletExecutedEvent {
            target,
            function,
            nonce: current_nonce,
        }
        .publish(&env);

        Ok(result)
    }

    /// Compute the canonical message payload bytes that a signer must sign to authorize `execute`.
    pub fn execution_payload(
        env: Env,
        target: Address,
        function: Symbol,
        args: Vec<Val>,
        nonce: u64,
    ) -> Bytes {
        let wallet_addr = env.current_contract_address();
        build_execution_payload(&env, &wallet_addr, &target, &function, &args, nonce)
    }

    fn require_initialized(env: &Env) -> Result<(), SmartWalletError> {
        if !env.storage().instance().has(&WalletDataKey::Initialized) {
            return Err(SmartWalletError::NotInitialized);
        }
        Ok(())
    }
}
