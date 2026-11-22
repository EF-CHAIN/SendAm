use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, Address, BytesN, Env, IntoVal, Symbol,
    Val, Vec,
};

use crate::wallet::{validate_signer_key, SignerKey, SmartWalletError};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FactoryDataKey {
    Initialized,
    Admin,
    WalletWasmHash,
    DeployedWallet(BytesN<32>),
    WalletCount,
}

#[contractevent(topics = ["factory", "init"])]
pub struct FactoryInitializedEvent {
    pub admin: Address,
}

#[contractevent(topics = ["factory", "set_wasm"])]
pub struct FactoryWasmUpdatedEvent {
    pub wasm_hash: BytesN<32>,
}

#[contractevent(topics = ["factory", "deploy"])]
pub struct WalletDeployedEvent {
    pub wallet_address: Address,
    pub salt: BytesN<32>,
    pub initial_signer: SignerKey,
}

#[contract]
pub struct SmartWalletFactory;

#[contractimpl]
impl SmartWalletFactory {
    /// Initialize the factory with an administrator address and optional proxy wallet WASM hash.
    pub fn init_factory(
        env: Env,
        admin: Address,
        wallet_wasm_hash: Option<BytesN<32>>,
    ) -> Result<(), SmartWalletError> {
        if env.storage().instance().has(&FactoryDataKey::Initialized) {
            return Err(SmartWalletError::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage()
            .instance()
            .set(&FactoryDataKey::Initialized, &true);
        env.storage().instance().set(&FactoryDataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&FactoryDataKey::WalletCount, &0u64);

        if let Some(hash) = wallet_wasm_hash {
            env.storage()
                .instance()
                .set(&FactoryDataKey::WalletWasmHash, &hash);
        }

        FactoryInitializedEvent { admin }.publish(&env);
        Ok(())
    }

    /// Update the WASM hash used when deploying new smart wallet contracts.
    pub fn set_wallet_wasm_hash(env: Env, wasm_hash: BytesN<32>) -> Result<(), SmartWalletError> {
        Self::require_initialized(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&FactoryDataKey::Admin)
            .ok_or(SmartWalletError::NotInitialized)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&FactoryDataKey::WalletWasmHash, &wasm_hash);

        FactoryWasmUpdatedEvent { wasm_hash }.publish(&env);
        Ok(())
    }

    /// Deterministically compute the contract address for a given 32-byte deployment salt.
    pub fn get_deployed_address(env: Env, salt: BytesN<32>) -> Address {
        env.deployer()
            .with_current_contract(salt)
            .deployed_address()
    }

    /// Return the registered smart wallet address for a given salt if already deployed.
    pub fn get_wallet(env: Env, salt: BytesN<32>) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&FactoryDataKey::DeployedWallet(salt))
    }

    /// Return the total number of smart wallets deployed by this factory.
    pub fn get_wallet_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&FactoryDataKey::WalletCount)
            .unwrap_or(0u64)
    }

    /// Deploy a deterministic smart contract wallet using the stored proxy WASM hash and initialize
    /// it with the user's passkey (`secp256r1`) or `ed25519` verification key.
    pub fn deploy_wallet(
        env: Env,
        salt: BytesN<32>,
        initial_signer: SignerKey,
    ) -> Result<Address, SmartWalletError> {
        Self::require_initialized(&env)?;
        validate_signer_key(&initial_signer)?;

        if env
            .storage()
            .persistent()
            .has(&FactoryDataKey::DeployedWallet(salt.clone()))
        {
            return Err(SmartWalletError::WalletAlreadyDeployed);
        }

        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&FactoryDataKey::WalletWasmHash)
            .ok_or(SmartWalletError::NotInitialized)?;

        let wallet_address = env
            .deployer()
            .with_current_contract(salt.clone())
            .deploy_v2(wasm_hash, ());

        let mut init_args: Vec<Val> = Vec::new(&env);
        init_args.push_back(initial_signer.clone().into_val(&env));
        let _: () = env.invoke_contract(&wallet_address, &Symbol::new(&env, "init"), init_args);

        env.storage().persistent().set(
            &FactoryDataKey::DeployedWallet(salt.clone()),
            &wallet_address,
        );

        let count = Self::get_wallet_count(env.clone()) + 1;
        env.storage()
            .instance()
            .set(&FactoryDataKey::WalletCount, &count);

        WalletDeployedEvent {
            wallet_address: wallet_address.clone(),
            salt,
            initial_signer,
        }
        .publish(&env);

        Ok(wallet_address)
    }
}

impl SmartWalletFactory {
    fn require_initialized(env: &Env) -> Result<(), SmartWalletError> {
        if !env.storage().instance().has(&FactoryDataKey::Initialized) {
            return Err(SmartWalletError::NotInitialized);
        }
        Ok(())
    }
}
