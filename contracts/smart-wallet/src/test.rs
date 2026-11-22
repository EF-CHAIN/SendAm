#![cfg(test)]
extern crate std;

use ed25519_dalek::{Signer as _, SigningKey as Ed25519SigningKey};
use p256::ecdsa::{
    signature::hazmat::PrehashSigner, Signature as P256Signature, SigningKey as P256SigningKey,
};
use sha2::{Digest, Sha256};
use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, Bytes, BytesN, Env,
    IntoVal, Symbol, TryFromVal, Val, Vec,
};

use crate::{
    factory::{SmartWalletFactory, SmartWalletFactoryClient},
    wallet::{
        build_execution_payload, SignaturePayload, SignerKey, SmartWalletContract,
        SmartWalletContractClient, SmartWalletError, WebAuthnSignature,
    },
};

mod smart_wallet_wasm {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/sendam_smart_wallet.wasm"
    );
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CounterKey {
    Value,
    LastCaller,
}

#[contract]
pub struct MockTargetContract;

#[contractimpl]
impl MockTargetContract {
    pub fn increment(env: Env, caller: Address, step: u32) -> u32 {
        caller.require_auth();
        let current: u32 = env
            .storage()
            .instance()
            .get(&CounterKey::Value)
            .unwrap_or(0);
        let updated = current + step;
        env.storage().instance().set(&CounterKey::Value, &updated);
        env.storage()
            .instance()
            .set(&CounterKey::LastCaller, &caller);
        updated
    }

    pub fn get_value(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&CounterKey::Value)
            .unwrap_or(0)
    }

    pub fn get_last_caller(env: Env) -> Option<Address> {
        env.storage().instance().get(&CounterKey::LastCaller)
    }
}

fn generate_ed25519_pair(env: &Env, seed: [u8; 32]) -> (Ed25519SigningKey, SignerKey) {
    let signing_key = Ed25519SigningKey::from_bytes(&seed);
    let verifying_key = signing_key.verifying_key();
    let pk_bytes = BytesN::from_array(env, &verifying_key.to_bytes());
    (signing_key, SignerKey::Ed25519(pk_bytes))
}

fn sign_ed25519(env: &Env, signing_key: &Ed25519SigningKey, payload: &Bytes) -> SignaturePayload {
    let mut raw = std::vec![0u8; payload.len() as usize];
    payload.copy_into_slice(&mut raw);
    let sig = signing_key.sign(&raw);
    SignaturePayload::Ed25519(BytesN::from_array(env, &sig.to_bytes()))
}

fn generate_secp256r1_pair(env: &Env, seed: [u8; 32]) -> (P256SigningKey, SignerKey) {
    let signing_key = P256SigningKey::from_slice(&seed).expect("valid p256 secret");
    let verifying_key = signing_key.verifying_key();
    let encoded_point = verifying_key.to_encoded_point(false);
    let mut uncompressed = [0u8; 65];
    uncompressed.copy_from_slice(encoded_point.as_bytes());
    (
        signing_key,
        SignerKey::Secp256r1(BytesN::from_array(env, &uncompressed)),
    )
}

fn sign_secp256r1_raw(
    env: &Env,
    signing_key: &P256SigningKey,
    payload: &Bytes,
) -> SignaturePayload {
    let mut raw = std::vec![0u8; payload.len() as usize];
    payload.copy_into_slice(&mut raw);
    let digest = Sha256::digest(&raw);
    let (sig, _): (P256Signature, _) = signing_key
        .sign_prehash(&digest)
        .expect("secp256r1 prehash sign");
    let normalized = sig.normalize_s().unwrap_or(sig);
    let sig_bytes: [u8; 64] = normalized.to_bytes().into();
    SignaturePayload::Secp256r1(BytesN::from_array(env, &sig_bytes))
}

fn sign_webauthn_passkey(
    env: &Env,
    signing_key: &P256SigningKey,
    payload: &Bytes,
    user_present: bool,
) -> SignaturePayload {
    let mut raw_payload = std::vec![0u8; payload.len() as usize];
    payload.copy_into_slice(&mut raw_payload);
    let challenge_hash = Sha256::digest(&raw_payload);

    // 37-byte authenticator data: 32-byte rpIdHash + 1-byte flags + 4-byte signCount
    let mut auth_data = [0u8; 37];
    auth_data[32] = if user_present { 0x05 } else { 0x00 }; // UP (0x01) + UV (0x04)

    // Embed the 32-byte challenge digest inside client_data_json
    let mut client_data = std::vec::Vec::new();
    client_data.extend_from_slice(b"{\"type\":\"webauthn.get\",\"challenge\":\"");
    client_data.extend_from_slice(&challenge_hash);
    client_data.extend_from_slice(b"\",\"origin\":\"https://sendam.app\"}");

    let client_data_hash = Sha256::digest(&client_data);
    let mut signed_message = std::vec::Vec::with_capacity(37 + 32);
    signed_message.extend_from_slice(&auth_data);
    signed_message.extend_from_slice(&client_data_hash);

    let final_digest = Sha256::digest(&signed_message);
    let (sig, _): (P256Signature, _) = signing_key
        .sign_prehash(&final_digest)
        .expect("webauthn prehash sign");
    let normalized = sig.normalize_s().unwrap_or(sig);
    let sig_bytes: [u8; 64] = normalized.to_bytes().into();

    SignaturePayload::WebAuthn(WebAuthnSignature {
        authenticator_data: Bytes::from_slice(env, &auth_data),
        client_data_json: Bytes::from_slice(env, &client_data),
        signature: BytesN::from_array(env, &sig_bytes),
    })
}

#[test]
fn test_factory_deploys_deterministic_smart_wallets_and_prevents_duplicates() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let wasm_hash = env.deployer().upload_contract_wasm(smart_wallet_wasm::WASM);

    let factory_id = env.register(SmartWalletFactory, ());
    let factory = SmartWalletFactoryClient::new(&env, &factory_id);

    factory.init_factory(&admin, &Some(wasm_hash));
    assert_eq!(factory.get_wallet_count(), 0);

    // Prevent duplicate factory initialization
    let dup_init = factory.try_init_factory(&admin, &None);
    assert_eq!(dup_init, Err(Ok(SmartWalletError::AlreadyInitialized)));

    let salt_1 = BytesN::from_array(&env, &[1u8; 32]);
    let (_, passkey_signer) = generate_secp256r1_pair(&env, [11u8; 32]);

    // Predicted address matches actual deployed address
    let predicted_address = factory.get_deployed_address(&salt_1);
    let deployed_address = factory.deploy_wallet(&salt_1, &passkey_signer);
    assert_eq!(predicted_address, deployed_address);
    assert_eq!(factory.get_wallet(&salt_1), Some(deployed_address.clone()));
    assert_eq!(factory.get_wallet_count(), 1);

    // Verify deployed proxy wallet is initialized with the passkey signer
    let wallet_client = SmartWalletContractClient::new(&env, &deployed_address);
    let signers = wallet_client.get_signers();
    assert_eq!(signers.len(), 1);
    assert_eq!(signers.get(0), Some(passkey_signer.clone()));
    assert_eq!(wallet_client.get_nonce(), 0);

    // Deploying again with the same salt fails with WalletAlreadyDeployed
    let duplicate_res = factory.try_deploy_wallet(&salt_1, &passkey_signer);
    assert_eq!(
        duplicate_res,
        Err(Ok(SmartWalletError::WalletAlreadyDeployed))
    );
}

#[test]
fn test_smart_wallet_executes_transactions_with_webauthn_passkey_and_ed25519() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let wasm_hash = env.deployer().upload_contract_wasm(smart_wallet_wasm::WASM);

    let factory_id = env.register(SmartWalletFactory, ());
    let factory = SmartWalletFactoryClient::new(&env, &factory_id);
    factory.init_factory(&admin, &Some(wasm_hash));

    let (p256_sk, passkey_signer) = generate_secp256r1_pair(&env, [22u8; 32]);
    let salt = BytesN::from_array(&env, &[2u8; 32]);
    let wallet_addr = factory.deploy_wallet(&salt, &passkey_signer);
    let wallet = SmartWalletContractClient::new(&env, &wallet_addr);

    let target_id = env.register(MockTargetContract, ());
    let target = MockTargetContractClient::new(&env, &target_id);

    // Build invocation args: increment(wallet_addr, 15)
    let fn_name = Symbol::new(&env, "increment");
    let mut args: Vec<Val> = Vec::new(&env);
    args.push_back(wallet_addr.clone().into_val(&env));
    args.push_back(15u32.into_val(&env));

    // 1. Execute via WebAuthn passkey signature (nonce = 0)
    let payload_0 = build_execution_payload(&env, &wallet_addr, &target_id, &fn_name, &args, 0);
    let webauthn_sig = sign_webauthn_passkey(&env, &p256_sk, &payload_0, true);

    let res_val = wallet.execute(&target_id, &fn_name, &args, &passkey_signer, &webauthn_sig);
    let new_counter: u32 = u32::try_from_val(&env, &res_val).unwrap();
    assert_eq!(new_counter, 15);
    assert_eq!(target.get_value(), 15);
    assert_eq!(target.get_last_caller(), Some(wallet_addr.clone()));
    assert_eq!(wallet.get_nonce(), 1);

    // 2. Replay attack with the same signature must fail because nonce advanced to 1
    // (ed25519/secp256r1 host trap on digest mismatch or invalid signature)
    let replay_attempt =
        wallet.try_execute(&target_id, &fn_name, &args, &passkey_signer, &webauthn_sig);
    assert!(replay_attempt.is_err());

    // 3. Add a backup Ed25519 signer and execute transaction with it (nonce = 1)
    let (ed_sk, ed_signer) = generate_ed25519_pair(&env, [33u8; 32]);
    wallet.add_signer(&ed_signer);
    assert_eq!(wallet.get_signers().len(), 2);

    let payload_1 = build_execution_payload(&env, &wallet_addr, &target_id, &fn_name, &args, 1);
    let ed_sig = sign_ed25519(&env, &ed_sk, &payload_1);

    let res_val_2 = wallet.execute(&target_id, &fn_name, &args, &ed_signer, &ed_sig);
    let new_counter_2: u32 = u32::try_from_val(&env, &res_val_2).unwrap();
    assert_eq!(new_counter_2, 30);
    assert_eq!(wallet.get_nonce(), 2);

    // 4. Execute with direct secp256r1 signature (nonce = 2)
    let payload_2 = build_execution_payload(&env, &wallet_addr, &target_id, &fn_name, &args, 2);
    let raw_p256_sig = sign_secp256r1_raw(&env, &p256_sk, &payload_2);

    let res_val_3 = wallet.execute(&target_id, &fn_name, &args, &passkey_signer, &raw_p256_sig);
    let new_counter_3: u32 = u32::try_from_val(&env, &res_val_3).unwrap();
    assert_eq!(new_counter_3, 45);
    assert_eq!(wallet.get_nonce(), 3);
}

#[test]
fn test_signer_management_and_edge_case_validations() {
    let env = Env::default();
    env.mock_all_auths();

    let wallet_id = env.register(SmartWalletContract, ());
    let wallet = SmartWalletContractClient::new(&env, &wallet_id);

    // Calling methods before initialization returns NotInitialized
    assert_eq!(
        wallet.try_get_nonce(),
        Err(Ok(SmartWalletError::NotInitialized))
    );

    // Reject malformed secp256r1 key that does not start with 0x04
    let mut bad_pk = [0u8; 65];
    bad_pk[0] = 0x02;
    let invalid_signer = SignerKey::Secp256r1(BytesN::from_array(&env, &bad_pk));
    assert_eq!(
        wallet.try_init(&invalid_signer),
        Err(Ok(SmartWalletError::InvalidKeyLength))
    );

    let (p256_sk, passkey_signer) = generate_secp256r1_pair(&env, [44u8; 32]);
    wallet.init(&passkey_signer);

    // Cannot remove the last remaining signer
    assert_eq!(
        wallet.try_remove_signer(&passkey_signer),
        Err(Ok(SmartWalletError::CannotRemoveLastSigner))
    );

    // Cannot add duplicate signer
    assert_eq!(
        wallet.try_add_signer(&passkey_signer),
        Err(Ok(SmartWalletError::SignerAlreadyExists))
    );

    // Add second signer, then remove first signer
    let (_, ed_signer) = generate_ed25519_pair(&env, [55u8; 32]);
    wallet.add_signer(&ed_signer);
    wallet.remove_signer(&passkey_signer);
    assert_eq!(wallet.get_signers().len(), 1);

    // Removed signer can no longer verify signatures
    let msg = Bytes::from_slice(&env, b"test-challenge");
    let sig = sign_webauthn_passkey(&env, &p256_sk, &msg, true);
    assert_eq!(
        wallet.try_verify_signature(&passkey_signer, &msg, &sig),
        Err(Ok(SmartWalletError::SignerNotFound))
    );

    // WebAuthn signature without User Present (UP) flag is rejected
    let wallet_2_id = env.register(SmartWalletContract, ());
    let wallet_2 = SmartWalletContractClient::new(&env, &wallet_2_id);
    wallet_2.init(&passkey_signer);
    let sig_no_up = sign_webauthn_passkey(&env, &p256_sk, &msg, false);
    assert_eq!(
        wallet_2.try_verify_signature(&passkey_signer, &msg, &sig_no_up),
        Err(Ok(SmartWalletError::InvalidSignature))
    );
}
